module.exports = {
    // Types of Apify.utils.log
    LOG_TYPES: {
        DEBUG: 'debug',
        INFO: 'info',
        WARNING: 'warning',
        ERROR: 'error',
        EXCEPTION: 'exception'
    },
    // Types of pages which this actor is able to process
    PAGE_TYPES: {
        PLACE: 'location',
        PROFILE: 'user',
        HASHTAG: 'hashtag',
        POST: 'post',
    },
    // Types of scrapes this actor can do
    SCRAPE_TYPES: {
        POSTS: 'posts',
        COMMENTS: 'comments',
        DETAILS: 'details',
    },
    // Types of search queries available in instagram search
    SEARCH_TYPES: {
        PLACE: 'place',
        USER: 'user',
        HASHTAG: 'hashtag',
    },
    PAGE_TYPE_URL_REGEXES: {
        PLACE: /https:\/\/www\.instagram\.com\/explore\/locations\/.+/,
        PROFILE: /https:\/\/www\.instagram\.com\/[^/]{2,}\/?$/,
        HASHTAG: /https:\/\/www\.instagram\.com\/explore\/tags\/.+/,
        POST: /https:\/\/www\.instagram.com\/p\/.+/,
    },
    // Instagrams GraphQL Endpoint URL
    GRAPHQL_ENDPOINT: 'https://www.instagram.com/graphql/query/?query_hash=',
    // Resource types blocked from loading to speed up the solution
    ABORT_RESOURCE_TYPES: [
        'image',
        'media',
        'font',
        'texttrack',
        'fetch',
        'eventsource',
        'websocket',
        'other',
        // Manifest and stylesheets have to be present!!!
    ],
    ABORT_RESOURCE_URL_INCLUDES: [
        'map_tile.php',
        'connect.facebook.net',
        'logging_client_events',
    ],
    // These are needed for scrolling to work
    // TODO: Retest this
    ABORT_RESOURCE_URL_DOWNLOAD_JS: [
        'es6/Consumer',
        'es6/ProfilePageContainer',
        'es6/PostPageContainer',
        'es6/PostPageComments',
        'es6/PostComment',
        'es6/cs_CZ.js',
        'es6/en',
        'es6/Vendor',
        'es6/ActivityFeedBox'
    ]
};
