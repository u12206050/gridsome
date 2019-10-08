const pMap = require('p-map')
const axios = require('axios')
const fs = require('fs')
const https = require('https')
const path = require('path')
const camelCase = require('camelcase')
const { mapKeys, isPlainObject, trimEnd, map, find } = require('lodash')

const TYPE_AUTHOR = 'author'
const TYPE_ATTACHEMENT = 'attachment'
const TMPDIR = '.temp/downloads'
const DOWNLOAD_DIR = 'wp-images'

function mkdirSyncRecursive (absDirectory) {
  const paths = absDirectory.replace(/\/$/, '').split('/')
  paths.splice(0, 1)

  let dirPath = '/'
  paths.forEach(segment => {
    dirPath += segment + '/'
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath)
  })
}

class WordPressSource {
  static defaultOptions () {
    return {
      baseUrl: '',
      apiBase: 'wp-json',
      perPage: 100,
      concurrent: 10,
      routes: {
        post: '/:slug',
        post_tag: '/tag/:slug',
        category: '/category/:slug',
        author: '/author/:slug'
      },
      typeName: 'WordPress',
      splitPostsIntoFragments: false,
      downloadRemoteImagesFromPosts: false,
      downloadRemoteFeaturedImages: false,
      downloadACFImages: false
    }
  }

  constructor (api, options) {
    const opts = this.options = { ...WordPressSource.defaultOptions, ...options }
    this.restBases = { posts: {}, taxonomies: {}}

    if (!opts.typeName) {
      throw new Error(`Missing typeName option.`)
    }

    if (opts.perPage > 100 || opts.perPage < 1) {
      throw new Error(`${opts.typeName}: perPage cannot be more than 100 or less than 1.`)
    }

    const baseUrl = trimEnd(opts.baseUrl, '/')

    this.client = axios.create({
      baseURL: `${baseUrl}/${opts.apiBase}`
    })

    this.routes = this.options.routes || {}

    /* Create image directories */
    mkdirSyncRecursive(path.resolve(DOWNLOAD_DIR))
    mkdirSyncRecursive(path.resolve(TMPDIR))
    this.tmpCount = 0

    this.slugify = str => api.store.slugify(str).replace(/-([^-]*)$/, '.$1')

    api.loadSource(async actions => {
      this.store = actions

      console.log(`Loading data from ${baseUrl}`)

      await this.getPostTypes(actions)
      await this.getUsers(actions)
      await this.getTaxonomies(actions)
      await this.getPosts(actions)
    })
  }

  async getPostTypes (actions) {
    const { data } = await this.fetch('wp/v2/types', {}, {})
    const addCollection = actions.addCollection || actions.addContentType

    for (const type in data) {
      const options = data[type]

      this.restBases.posts[type] = options.rest_base

      addCollection({
        typeName: this.createTypeName(type),
        route: this.routes[type] || `/${type}/:slug`
      })
    }
  }

  async getUsers (actions) {
    const { data } = await this.fetch('wp/v2/users')
    const addCollection = actions.addCollection || actions.addContentType

    const authors = addCollection({
      typeName: this.createTypeName(TYPE_AUTHOR),
      route: this.routes.author
    })

    for (const author of data) {
      const fields = this.normalizeFields(author)
      const avatars = mapKeys(author.avatar_urls, (v, key) => `avatar${key}`)

      authors.addNode({
        ...fields,
        id: author.id,
        title: author.name,
        avatars
      })
    }
  }

  async getTaxonomies (actions) {
    const { data } = await this.fetch('wp/v2/taxonomies', {}, {})
    const addCollection = actions.addCollection || actions.addContentType

    for (const type in data) {
      const options = data[type]
      const taxonomy = addCollection({
        typeName: this.createTypeName(type),
        route: this.routes[type]
      })

      this.restBases.taxonomies[type] = options.rest_base

      const terms = await this.fetchPaged(`wp/v2/${options.rest_base}`)

      for (const term of terms) {
        taxonomy.addNode({
          id: term.id,
          title: term.name,
          slug: term.slug,
          content: term.description,
          count: term.count
        })
      }
    }
  }

  extractImagesFromPostHtml (string) {
    const regex = /<img[^>]* src=\"([^\"]*)\" alt=\"([^\"]*)\"[^>]*>/gm

    const matches = []
    let m
    while ((m = regex.exec(string)) !== null) {
      // This is necessary to avoid infinite loops with zero-width matches
      if (m.index === regex.lastIndex) {
        regex.lastIndex++
      }

      // The result can be accessed through the `m`-variable.
      m.forEach((match, groupIndex) => {
        matches.push({
          url: match[1],
          alt: match[2]
        })
      })
    }

    return matches
  }

  async downloadImage (url, destPath, fileName) {
    const imagePath = path.resolve(destPath, fileName)

    try {
      if (fs.existsSync(imagePath)) return
    } catch (err) {
      console.log(err)
    }

    const tmpPath = path.resolve(TMPDIR, `${++this.tmpCount}.tmp`)

    return new Promise(function (resolve, reject) {
      const file = fs.createWriteStream(tmpPath)
      https.get(url, (response) => {
        response.pipe(file)
        file.on('finish', () => {
          file.close()
          fs.rename(tmpPath, imagePath, resolve)
        })
      }).on('error', (err) => {
        console.error(err.message)
        fs.unlinkSync(tmpPath) // Cleanup blank file
        reject(err)
      })
    })
  }

  processPostFragments (post) {
    const postImages = this.extractImagesFromPostHtml(post)

    const regex = /<img[^>]* src=\"([^\"]*)\"[^>]*>/
    const fragments = post.split(regex)

    return map(fragments, (fragment, index) => {
      const image = find(postImages, (image) => { return image.url === fragment })
      if (image && this.options.downloadRemoteImagesFromPosts) {
        const fileName = this.slugify(fragment.split('/').pop())
        const imageData = {
          type: 'img',
          order: index + 1,
          fragmentData: {
            remoteUrl: fragment,
            fileName: fileName,
            image: path.resolve(DOWNLOAD_DIR, fileName),
            alt: image.alt
          }
        }
        this.downloadImage(
          fragment,
          DOWNLOAD_DIR,
          fileName
        )
        return imageData
      } else {
        return {
          type: 'html',
          order: index + 1,
          fragmentData: {
            html: fragment
          }
        }
      }
    })
  }

  async getPosts (actions) {
    const { createReference } = actions
    const getCollection = actions.getCollection || actions.getContentType

    const AUTHOR_TYPE_NAME = this.createTypeName(TYPE_AUTHOR)
    const ATTACHEMENT_TYPE_NAME = this.createTypeName(TYPE_ATTACHEMENT)

    for (const type in this.restBases.posts) {
      const restBase = this.restBases.posts[type]
      const typeName = this.createTypeName(type)
      const posts = getCollection(typeName)

      const data = await this.fetchPaged(`wp/v2/${restBase}?_embed`)

      for (const post of data) {
        const fields = this.normalizeFields(post)
        fields.author = createReference(AUTHOR_TYPE_NAME, post.author || '0')

        if (post.type !== TYPE_ATTACHEMENT) {
          fields.featuredMedia = createReference(ATTACHEMENT_TYPE_NAME, post.featured_media)
        }

        // add references if post has any taxonomy rest bases as properties
        for (const type in this.restBases.taxonomies) {
          const propName = this.restBases.taxonomies[type]

          if (post.hasOwnProperty(propName)) {
            const typeName = this.createTypeName(type)
            const ref = createReference(typeName, post[propName])
            const key = camelCase(propName)

            fields[key] = ref
          }
        }

        if (this.options.splitPostsIntoFragments && fields['content']) { fields.postFragments = this.processPostFragments(fields['content']) }

        // download the featured image
        if (this.options.downloadRemoteFeaturedImages && post._embedded && post._embedded['wp:featuredmedia']) {
          try {
            const featuredImageFileName = this.slugify(post._embedded['wp:featuredmedia']['0'].source_url.split('/').pop())
            await this.downloadImage(
              post._embedded['wp:featuredmedia']['0'].source_url,
              DOWNLOAD_DIR,
              featuredImageFileName
            )
            fields.featuredMediaImage = path.resolve(DOWNLOAD_DIR, featuredImageFileName)
          } catch (err) {
            console.log(err)
            console.log('WARNING - No featured image for post ' + post.slug)
          }
        }

        posts.addNode({
          ...fields,
          id: post.id
        })
      }
    }
  }

  async fetch (url, params = {}, fallbackData = []) {
    let res

    try {
      res = await this.client.request({ url, params })
    } catch ({ response, code, config }) {
      if (!response && code) {
        throw new Error(`${code} - ${config.url}`)
      }

      const { url } = response.config
      const { status } = response.data.data

      if ([401, 403].includes(status)) {
        console.warn(`Error: Status ${status} - ${url}`)
        return { ...response, data: fallbackData }
      } else {
        throw new Error(`${status} - ${url}`)
      }
    }

    return res
  }

  async fetchPaged (path) {
    const { perPage, concurrent } = this.options

    return new Promise(async (resolve, reject) => {
      let res

      try {
        res = await this.fetch(path, { per_page: perPage })
      } catch (err) {
        return reject(err)
      }

      const totalItems = parseInt(res.headers['x-wp-total'], 10)
      const totalPages = parseInt(res.headers['x-wp-totalpages'], 10)

      try {
        res.data = ensureArrayData(path, res.data)
      } catch (err) {
        return reject(err)
      }

      if (!totalItems || totalPages <= 1) {
        return resolve(res.data)
      }

      const queue = []

      for (let page = 2; page <= totalPages; page++) {
        queue.push({ per_page: perPage, page })
      }

      await pMap(queue, async params => {
        try {
          const { data } = await this.fetch(path, params)
          res.data.push(...ensureArrayData(path, data))
        } catch (err) {
          console.log(err.message)
        }
      }, { concurrency: concurrent })

      resolve(res.data)
    })
  }

  normalizeFields (fields, isACF) {
    const res = {}

    for (const key in fields) {
      if (key.startsWith('_')) continue // skip links and embeds etc
      res[camelCase(key)] = this.normalizeFieldValue(fields[key], isACF || key === 'acf')
    }

    return res
  }

  normalizeFieldValue (value, isACF) {
    if (value === null) return null
    if (value === undefined) return null

    if (Array.isArray(value)) {
      return value.map(v => this.normalizeFieldValue(v, isACF))
    }

    if (isPlainObject(value)) {
      if (value.type === 'image' && value.filename && value.url && isACF && this.options.downloadACFImages) {
        const filename = this.slugify(value.filename)
        this.downloadImage(
          value.url,
          DOWNLOAD_DIR,
          filename
        )
        return {
          src: path.resolve(DOWNLOAD_DIR, filename),
          title: value.title,
          alt: value.description
        }
      } else if (value.post_type && (value.ID || value.id)) {
        const typeName = this.createTypeName(value.post_type)
        const id = value.ID || value.id

        return this.store.createReference(typeName, id)
      } else if (value.filename && (value.ID || value.id)) {
        const typeName = this.createTypeName(TYPE_ATTACHEMENT)
        const id = value.ID || value.id

        return this.store.createReference(typeName, id)
      } else if (value.hasOwnProperty('rendered')) {
        return value.rendered
      }

      return this.normalizeFields(value, isACF)
    }

    if (isACF && this.options.downloadACFImages && String(value).match(/^https:\/\/.*\/.*\.(jpg|png|svg|jpeg)($|\?)/i)) {
      const filename = this.slugify(value.split('/').pop())
      console.log(`Downloading ${filename}`)
      this.downloadImage(
        value,
        DOWNLOAD_DIR,
        filename
      )
      return path.resolve(DOWNLOAD_DIR, filename)
    }

    return value
  }

  createTypeName (name = '') {
    return camelCase(`${this.options.typeName} ${name}`, { pascalCase: true })
  }
}

function ensureArrayData (url, data) {
  if (!Array.isArray(data)) {
    try {
      data = JSON.parse(data)
    } catch (err) {
      throw new Error(
        `Failed to fetch ${url}\n` +
        `Expected JSON response but received:\n` +
        `${data.trim().substring(0, 150)}...\n`
      )
    }
  }
  return data
}

module.exports = WordPressSource
