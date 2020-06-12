const Apify = require('apify');
const _ = require('underscore');

const crypto = require('crypto');
const { scrapePosts, handlePostsGraphQLResponse, scrapePost } = require('./posts');
const { scrapeComments, handleCommentsGraphQLResponse }  = require('./comments');
const { scrapeDetails }  = require('./details');
const { searchUrls } = require('./search');
const { getItemSpec, parseExtendOutputFunction } = require('./helpers');
const { GRAPHQL_ENDPOINT, ABORT_RESOURCE_TYPES, ABORT_RESOURCE_URL_INCLUDES, ABORT_RESOURCE_URL_DOWNLOAD_JS, SCRAPE_TYPES, PAGE_TYPES } = require('./consts');
const { initQueryIds } = require('./query_ids');
const errors = require('./errors');
const { formatProfileOutput, formatSinglePost } = require('./details');

async function main() {
    const input = await Apify.getInput();
    const matcherUsername = /instagram\.com\/(?<username>[A-Za-z0-9-_\.]+)/;
    const {
        proxy,
        resultsType,
        useAjson,
        resultsLimit = 200,
        scrapePostsUntilDate,
        scrollWaitSecs = 15,
        pageTimeout = 60,
        maxRequestRetries,
        loginCookies,
        directUrls = [],
    } = input;

    const extendOutputFunction = parseExtendOutputFunction(input.extendOutputFunction);

    if (proxy.apifyProxyGroups && proxy.apifyProxyGroups.length === 0) delete proxy.apifyProxyGroups;

    await initQueryIds();

    // We have to keep a state of posts/comments we already scraped so we don't push duplicates
    // TODO: Cleanup individual users/posts after all posts/comments are pushed
    const scrollingState = (await Apify.getValue('STATE-SCROLLING')) || {};
    const persistState = async () => { await Apify.setValue('STATE-SCROLLING', scrollingState)}
    setInterval(persistState, 5000);
    Apify.events.on('persistState', persistState);

    let maxConcurrency = 1000;

    const usingLogin = loginCookies && Array.isArray(loginCookies);

    if (usingLogin) {
        Apify.utils.log.warning('Cookies were used, setting maxConcurrency to 1 and using one proxy session!');
        maxConcurrency = 1;
        const session = crypto.createHash('sha256').update(JSON.stringify(loginCookies)).digest('hex').substring(0,16)
        if (proxy.useApifyProxy) proxy.apifyProxySession = `insta_session_${session}`;
    }

    try {
        if (!proxy) throw errors.proxyIsRequired();
        if (!resultsType) throw errors.typeIsRequired();
        if (!Object.values(SCRAPE_TYPES).includes(resultsType)) throw errors.unsupportedType(resultsType);
    } catch (error) {
        Apify.utils.log.info('--  --  --  --  --');
        Apify.utils.log.info(' ');
        Apify.utils.log.error('Run failed because the provided input is incorrect:');
        Apify.utils.log.error(error.message);
        Apify.utils.log.info(' ');
        Apify.utils.log.info('--  --  --  --  --');
        process.exit(1);
    }

    if (proxy && proxy.useApifyProxy && (!proxy.apifyProxyGroups || !proxy.apifyProxyGroups.includes('RESIDENTIAL'))) {
        Apify.utils.log.warning('You are using Apify proxy but not residential group! It is very likely it will not work properly. Please contact support@apify.com for access to residential proxy.')
    }

    let requestListSources;
    if (Array.isArray(directUrls) && directUrls.length > 0) {
        Apify.utils.log.warning('Search is disabled when Direct URLs are used');
        requestListSources = directUrls.map((url) => ({
            url: useAjson ? `${url}?__a=1` : url,
            userData: { limit: resultsLimit, scrapePostsUntilDate },
        }));
    } else {
        const urlsWithTypes = await searchUrls(input);
        requestListSources = urlsWithTypes.map((urlObj) => ({
            url: urlObj.url,
            userData: { limit: resultsLimit, scrapePostsUntilDate, pageType: urlObj.pageType },
        }));
    }

    if (requestListSources.length === 0) {
        Apify.utils.log.info('No URLs to process');
        process.exit(0);
    }

    const requestList = await Apify.openRequestList('request-list', requestListSources);

    let cookies = loginCookies;

    const gotoAjsonFunction = async ({ request, page }) => {
        const response = await page.goto(request.url, {
            timeout: pageTimeout * 1000,
        });
        return response;
    };

    const gotoFunction = async ({ request, page }) => {
        await page.setBypassCSP(true);
        if (cookies && Array.isArray(cookies)) {
            await page.setCookie(...cookies);
        } else if (input.loginUsername && input.loginPassword) {
            await login(input.loginUsername, input.loginPassword, page)
            cookies = await page.cookies();
        };

        // TODO: Refactor to use https://sdk.apify.com/docs/api/puppeteer#puppeteerblockrequestspage-options
        // Keep in mind it requires more manual setup than page.setRequestInterception
        await page.setRequestInterception(true);

        const isScrollPage = resultsType === SCRAPE_TYPES.POSTS || resultsType === SCRAPE_TYPES.COMMENTS;
        Apify.utils.log.debug(`Is scroll page: ${isScrollPage}`);

        const { pageType } = request.userData;

        page.on('request', (req) => {
            // We need to load some JS when we want to scroll
            // Hashtag & place pages seems to require even more JS allowed but this needs more research
            const isJSBundle = req.url().includes('instagram.com/static/bundles/');
            const abortJSBundle = isScrollPage
                ? (!ABORT_RESOURCE_URL_DOWNLOAD_JS.some((urlMatch) => req.url().includes(urlMatch)) && ![PAGE_TYPES.HASHTAG, PAGE_TYPES.PLACE].includes(pageType))
                : true

            if (
                ABORT_RESOURCE_TYPES.includes(req.resourceType())
                || ABORT_RESOURCE_URL_INCLUDES.some((urlMatch) => req.url().includes(urlMatch))
                || (isJSBundle && abortJSBundle)
            ) {
                Apify.utils.log.debug(`Aborting url: ${req.url()}`);
                return req.abort();
            }
            Apify.utils.log.debug(`Processing url: ${req.url()}`);
            req.continue();
        });


        page.on('response', async (response) => {
            const responseUrl = response.url();

            // Skip non graphql responses
            if (!responseUrl.startsWith(GRAPHQL_ENDPOINT)) return;

            // Wait for the page to parse it's data
            while (!page.itemSpec) await page.waitFor(100);

            // console.log('caught response')

            try {
                switch (resultsType) {
                    case SCRAPE_TYPES.POSTS: return handlePostsGraphQLResponse({ page, response, scrollingState })
                    case SCRAPE_TYPES.COMMENTS: return handleCommentsGraphQLResponse({ page, response, scrollingState })
                }
            } catch (e) {
                Apify.utils.log.error(`Error happened while processing response: ${e.message}`);
                console.log(e.stack);
            }
        });

        const response = await page.goto(request.url, {
            // itemSpec timeouts
            timeout: pageTimeout * 1000,
        });

        if (usingLogin) {
            try {
                const viewerId = await page.evaluate(() => window._sharedData.config.viewerId);
                if (!viewerId) throw new Error('Failed to log in using cookies, they are probably no longer usable and you need to set new ones.');
            } catch (loginError) {
                Apify.utils.log.error(loginError.message);
                process.exit(1);
            }
        }
        return response;
    };

    const handleAjsonPageFunction = async ({ page, puppeteerPool, request, response }) => {
        if (response.status() === 404) {
            const match = request.url.match(matcherUsername);
            const result = {
                url: request.url,
                found: false,
                ...match.groups,
            };
            await Apify.pushData(result);
            return;
        }
        const contentType = response.headers()['content-type'];
        if (!contentType.includes('application/json')) {
            return;
        }
        const json = await response.json();
        let result;
        if (json.graphql) {
            if (json.graphql.user) {
                result = await formatProfileOutput(input, request, json.graphql.user, page, {}, {});
            } else if (json.graphql.shortcode_media) {
                result = await formatSinglePost(json.graphql.shortcode_media);
            }
        }
        await Apify.pushData(result);
    };

    const handlePageFunction = async ({ page, puppeteerPool, request, response }) => {
        if (response.status() === 404) {
            Apify.utils.log.error(`Page "${request.url}" does not exist.`);
            if (request.url.match(matcherUsername)) {
                const result = {
                    url: request.url,
                    found: false,
                    ...request.url.match(matcherUsername).groups,
                };
                await Apify.pushData(result);
            }
            return;
        }
        const error = await page.$('body.p-error');
        if (error) {
            Apify.utils.log.error(`Page "${request.url}" is private and cannot be displayed.`);
            return;
        }
        // eslint-disable-next-line no-underscore-dangle
        await page.waitFor(() => (!window.__initialData.pending && window.__initialData && window.__initialData.data), { timeout: 20000 });
        // eslint-disable-next-line no-underscore-dangle
        const { pending, data } = await page.evaluate(() => window.__initialData);
        if (pending) throw new Error('Page took too long to load initial data, trying again.');
        if (!data || !data.entry_data) throw new Error('Page does not contain initial data, trying again.');
        const { entry_data: entryData } = data;

        if (entryData.LoginAndSignupPage) {
            await puppeteerPool.retire(page.browser());
            throw errors.redirectedToLogin();
        }

        const itemSpec = getItemSpec(entryData);
        // Passing the limit around
        itemSpec.limit = request.userData.limit || 999999;
        itemSpec.scrapePostsUntilDate = request.userData.scrapePostsUntilDate;
        itemSpec.input = input;
        itemSpec.scrollWaitSecs = scrollWaitSecs;

        let userResult = {};
        if (extendOutputFunction) {
            userResult = await page.evaluate((functionStr) => {
                // eslint-disable-next-line no-eval
                const f = eval(functionStr);
                return f();
            }, input.extendOutputFunction);
        }

        if (request.userData.label === 'postDetail') {
            const result = scrapePost(request, itemSpec, entryData);
            _.extend(result, userResult);

            await Apify.pushData(result);
        } else {
            page.itemSpec = itemSpec;
            switch (resultsType) {
                case SCRAPE_TYPES.POSTS: return scrapePosts({ page, request, itemSpec, entryData, input, scrollingState, puppeteerPool });
                case SCRAPE_TYPES.COMMENTS: return scrapeComments({ page, itemSpec, entryData, scrollingState });
                case SCRAPE_TYPES.DETAILS: return scrapeDetails({ input, request, itemSpec, entryData, page, proxy, userResult });
                default: throw new Error('Not supported');
            }
        }
    };

    if (proxy.apifyProxyGroups && proxy.apifyProxyGroups.length === 0) delete proxy.apifyProxyGroups;

    const requestQueue = await Apify.openRequestQueue();

    const crawler = new Apify.PuppeteerCrawler({
        requestList,
        requestQueue,
        gotoFunction: useAjson ? gotoAjsonFunction : gotoFunction,
        maxRequestRetries,
        puppeteerPoolOptions: {
            maxOpenPagesPerInstance: 1,
            retireInstanceAfterRequestCount: 30,
        },
        launchPuppeteerOptions: {
            ...proxy,
            stealth: true,
            useChrome: !useAjson,
            ignoreHTTPSErrors: true,
            args: ['--enable-features=NetworkService', '--ignore-certificate-errors'],
        },
        maxConcurrency: 100,
        handlePageTimeoutSecs: 300 * 60, // Ex: 5 hours to crawl thousands of comments
        handlePageFunction: useAjson ? handleAjsonPageFunction : handlePageFunction,

        // If request failed 4 times then this function is executed.
        handleFailedRequestFunction: async ({ request }) => {
            Apify.utils.log.error(`${request.url}: Request ${request.url} failed ${maxRequestRetries + 1} times, not retrying any more`);
            await Apify.pushData({
                '#debug': Apify.utils.createRequestDebugInfo(request),
                '#error': request.url,
            });
        },
    });

    await crawler.run();
}

module.exports = main;
