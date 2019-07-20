# gridsome-source-wordpress

> WordPress source for Gridsome with support for downloading images.

## Install
- `yarn add gridsome-source-wordpress`
- `npm install gridsome-source-wordpress`

## Usage

Add `wp-images` to your `.gitignore`

```js
module.exports = {
  plugins: [
    {
      use: 'gridsome-source-wordpress',
      options: {
        baseUrl: 'WEBSITE_URL', // required
        apiBase: 'wp-json',
        typeName: 'WordPress',
        perPage: 100,
        concurrent: 10,
        routes: {
          post: '/:year/:month/:day/:slug',
          post_tag: '/tag/:slug'
        },
        splitPostsIntoFragments: true, // default false
        downloadRemoteImagesFromPosts: true, // default false
        downloadRemoteFeaturedImages: true, // default false
        downloadACFImages: true, // default false
      }
    }
  ]
}
```

## Use with Advanced Custom Fields

Install the [ACF to REST API](https://github.com/airesvsg/acf-to-rest-api) plugin to make ACF fields available in the GraphQL schema.


`downloadACFImages: true` when downloading images, the result will like this object:

```
image: {
  src: ...//GRIDSOME IMAGE OBJECT,
  alt: 'Any description text',
  title: 'Title text of the image'
}
```

Usage: `<g-image :src="image.src" :alt="image.alt" />`

## Splitting Posts Into Fragments

`splitPostsIntoFragments: true` This will expose the following on posts that you can request via GraphQL:

**Query**
```
  postFragments {
      type
      fragmentData {
          image
          alt
          html
      }
  }
```

Each fragment is either of type `img` or `html` so you can render like so:

**Render**
```
  <template v-if="$page.wordPressPost.postFragments">
    <template v-for="(fragment, i) in $page.wordPressPost.postFragments">
      <!-- Fragment is a html block -->
      <template v-if="fragment.type == 'html'">
        <div :key="html-${i}" v-html="fragment.fragmentData.html" class="entry-content"></div>
      </template>

      <!-- Fragment is a image -->
      <template v-if="fragment.type == 'img' && fragment.fragmentData.image">
        <g-image :key="img-${i}" :src="fragment.fragmentData.image" :alt="fragment.fragmentData.alt"/>
      </template>
    </template>
  </template>
```

### Caveats

**Folders not existing?**

Manually create the following directories in your project:

```
/
  .temp/
    downloads/
  wp-images/
```


### Tips

**Exclude unnecessary data from ACF fields**

Gridsome needs the `Return format` set to `Post Object` for `Post Object` relations in order to resolve references automatically. But Gridsome only need the `post_type` and `id` to set up a working GraphQL reference. Use the filter below to exclude all other fields.

```php
add_filter( 'acf/format_value', function ( $value ) {
  if ( $value instanceof WP_Post ) {
    return [
      'post_type' => $value->post_type,
      'id'        => $value->ID,
    ];
  }

  return $value;
}, 100 );
```
