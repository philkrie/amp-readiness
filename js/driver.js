/**
 * WebExtension driver
 */

/* eslint-env browser */
/* global browser, chrome, fetch, Wappalyzer */

/** global: browser */
/** global: chrome */
/** global: fetch */
/** global: Wappalyzer */

const wappalyzer = new Wappalyzer();

const tabCache = {};
let categoryOrder = [];
const options = {};
const robotsTxtQueue = {};

browser.tabs.onRemoved.addListener((tabId) => {
  tabCache[tabId] = null;
});

/**
 * Get a value from localStorage
 */
function getOption(name, defaultValue = null) {
  return new Promise((resolve, reject) => {
    const callback = (item) => {
      options[name] = item[name] ? item[name] : defaultValue;

      resolve(options[name]);
    };

    browser.storage.local.get(name)
      .then(callback)
      .catch((error) => {
        wappalyzer.log(error, 'driver', 'error');

        reject();
      });
  });
}

/**
 * Set a value in localStorage
 */
function setOption(name, value) {
  const option = {};

  option[name] = value;

  browser.storage.local.set(option);

  options[name] = value;
}

/**
 * Open a tab
 */
function openTab(args) {
  browser.tabs.create({
    url: args.url,
    active: args.background === undefined || !args.background,
  });
}

/**
 * Make a POST request
 */
function post(url, body) {
  fetch(url, {
    method: 'POST',
    body: JSON.stringify(body),
  })
    .then(response => wappalyzer.log(`POST ${url}: ${response.status}`, 'driver'))
    .catch(error => wappalyzer.log(`POST ${url}: ${error}`, 'driver', 'error'));
}

function readApps(json) {
  wappalyzer.apps = json.apps;
  wappalyzer.categories = json.categories;
  
  fetch('../extended_apps.json')
    .then(response_ext => response_ext.json())
    .then((json_ext) => {

      wappalyzer.apps = Object.assign({}, wappalyzer.apps, json_ext.apps);

      wappalyzer.parseJsPatterns();

      categoryOrder = Object.keys(wappalyzer.categories)
        .map(categoryId => parseInt(categoryId, 10))
        .sort((a, b) => wappalyzer.categories[a].priority - wappalyzer.categories[b].priority);

      wappalyzer.supported_apps = json_ext.supported;
      wappalyzer.incompatible_apps = json_ext.incompatible;
      wappalyzer.cat_tooltips = json_ext.conversionCategoryTooltips;
      wappalyzer.tech_tooltips = json_ext.technologyTooltips;        
      wappalyzer.convertable_apps = json_ext.conversionPatterns;  
      wappalyzer.tracked_urls = {};      
  })
  .catch(error => wappalyzer.log(`GET extended_apps.json: ${error}`, 'driver', 'error'));
}

// We always fetch directly from Wappalyzer's raw apps.json content to get the latest content
fetch('https://raw.githubusercontent.com/AliasIO/Wappalyzer/master/src/apps.json')
  .then((response) => {
    //If we don't get a 200, we access the local version
    if(!response.ok) {
      console.log("Failed to retrive apps.json, falling back to local version");
      fetch('../apps.json')
      .then(response => response.json())
      .then(json => readApps(json))
    } else {
      response.json()
      .then(json => readApps(json))
    }
  })
  .catch(error => wappalyzer.log(`GET apps.json: ${error}`, 'driver', 'error'));

 // Version check. We only show this notification for new users and users upgrading from versions below 4.0
(async () => {
  const { version }  = browser.runtime.getManifest();
  const previousVersion = await getOption('version');

  console.log("current version: " + version)
  console.log("previous version: " + previousVersion)


  if (previousVersion === null || previousVersion < 4.0) {
    openTab({
      url: `https://github.com/ampproject/amp-readiness/wiki/AMP-Readiness-4.0`,
    });
  }

  await setOption('version', version);
})();
getOption('dynamicIcon', false);


getOption('hostnameCache', {})
  .then((hostnameCache) => {
    wappalyzer.hostnameCache = hostnameCache;

    return hostnameCache;
  });

// Run content script on all tabs
browser.tabs.query({ url: ['http://*/*', 'https://*/*'] })
  .then((tabs) => {
    wappalyzer.log('driver', 'new tab opened');
    tabs.forEach((tab) => {
      browser.tabs.executeScript(tab.id, {
        file: '../js/content.js',
      });
    });
  })
  .catch(error => wappalyzer.log(error, 'driver', 'error'));

// Capture response headers
browser.webRequest.onCompleted.addListener((request) => {
  const headers = {};

  if (request.responseHeaders) {
    const url = wappalyzer.parseUrl(request.url);

    browser.tabs.query({ url: [url.href] })
      .then((tabs) => {
        const tab = tabs[0] || null;

        if (tab) {
          request.responseHeaders.forEach((header) => {
            const name = header.name.toLowerCase();

            headers[name] = headers[name] || [];

            headers[name].push((header.value || header.binaryValue || '').toString());
          });

          if (headers['content-type'] && /\/x?html/.test(headers['content-type'][0])) {
            wappalyzer.analyze(url, { headers }, { tab });
          }
        }
      })
      .catch(error => wappalyzer.log(error, 'driver', 'error'));
  }
}, { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] }, ['responseHeaders']);

// Listen for messages
(chrome || browser).runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (typeof message.id !== 'undefined') {
    if (message.id !== 'log') {
      wappalyzer.log(`Message${message.source ? ` from ${message.source}` : ''}: ${message.id}`, 'driver');
    }

    const url = wappalyzer.parseUrl(sender.tab ? sender.tab.url : '');
    let response;

    switch (message.id) {
      case 'log':
        wappalyzer.log(message.subject, message.source);

        break;
      case 'init':
        browser.cookies.getAll({ domain: `.${url.hostname}` })
          .then(cookies => wappalyzer.analyze(url, { cookies }, { tab: sender.tab }));

        break;
      case 'analyze':
        wappalyzer.analyze(url, message.subject, { tab: sender.tab });

        setOption('hostnameCache', wappalyzer.hostnameCache);

        break;
      case 'ad_log':
        wappalyzer.cacheDetectedAds(message.subject);

        break;
      case 'get_apps':
        response = {
          tabCache: tabCache[message.tab.id],
          apps: wappalyzer.apps,
          categories: wappalyzer.categories,
          pinnedCategory: options.pinnedCategory,
          supported_apps: wappalyzer.supported_apps,
          incompatible_apps: wappalyzer.incompatible_apps,
          cat_tooltips: wappalyzer.cat_tooltips,
          tech_tooltips: wappalyzer.tech_tooltips,
          convertable_apps: wappalyzer.convertable_apps,
          tracked_urls: getUrlCache(message.tab.id),
          html: wappalyzer.pageHtml,
        };
        
        break;

      case 'set_option':
        setOption(message.key, message.value);

        break;
      case 'get_js_patterns':
        response = {
          patterns: wappalyzer.jsPatterns,
        };

        break;
      default:
    }

    sendResponse(response);
  }

  return true;
});

wappalyzer.driver.document = document;

/**
 * Url Caching (populated via via network.js) helpers
 */
const networkFilters = {
  urls: ["*://*/*"]
};
const urlCache = {};
function addUrlToRequestCache(tab, url) {
  wappalyzer.log("Tab: " + tab);

	if (typeof urlCache[tab] === "undefined") {
    wappalyzer.log("New Tab");
		urlCache[tab] = [];
  }
  wappalyzer.log("Adding URL: " + url);
  urlCache[tab].push(url);

}
function getUrlCache(tab) {
	return typeof urlCache[tab] !== "undefined" 
		? urlCache[tab] 
		: {};
}
function clearRequestCache(tab) {
	urlCache[tab] = null;
}

chrome.webRequest.onBeforeRequest.addListener((details) => {

  const { tabId, requestId } = details;
  addUrlToRequestCache(tabId, details.url);
  return;
}, networkFilters);

/**
 * Log messages to console
 */
wappalyzer.driver.log = (message, source, type) => {
  console.log(`[wappalyzer ${type}]`, `[${source}]`, message);
};

/**
 * Display apps
 */
wappalyzer.driver.displayApps = (detected, meta, context) => {
  const { tab } = context;

  if (tab === undefined) {
    return;
  }

  tabCache[tab.id] = tabCache[tab.id] || {
    detected: [],
  };

  tabCache[tab.id].detected = detected;

  let found = false;
  if (typeof chrome !== 'undefined') {
    // Browser polyfill doesn't seem to work here
    chrome.pageAction.show(tab.id);
  } else {
    browser.pageAction.show(tab.id);
  }
};

/**
 * Fetch and cache robots.txt for host
 */
wappalyzer.driver.getRobotsTxt = (host, secure = false) => {
  if (robotsTxtQueue[host]) {
    return robotsTxtQueue[host];
  }

  robotsTxtQueue[host] = new Promise((resolve) => {
    getOption('tracking', true)
      .then((tracking) => {
        if (!tracking) {
          resolve([]);

          return;
        }

        getOption('robotsTxtCache')
          .then((robotsTxtCache) => {
            robotsTxtCache = robotsTxtCache || {};

            if (host in robotsTxtCache) {
              resolve(robotsTxtCache[host]);

              return;
            }

            const timeout = setTimeout(() => resolve([]), 3000);

            fetch(`http${secure ? 's' : ''}://${host}/robots.txt`, { redirect: 'follow' })
              .then((response) => {
                clearTimeout(timeout);

                return response.ok ? response.text() : '';
              })
              .then((robotsTxt) => {
                robotsTxtCache[host] = Wappalyzer.parseRobotsTxt(robotsTxt);

                setOption('robotsTxtCache', robotsTxtCache);

                resolve(robotsTxtCache[host]);
              })
              .catch(() => resolve([]));
          });
      });
  })
    .finally(() => delete robotsTxtQueue[host]);

  return robotsTxtQueue[host];
};

/**
 * Anonymously track detected applications for research purposes
 */
wappalyzer.driver.ping = (hostnameCache = {}, adCache = []) => {
  getOption('tracking', true)
    .then((tracking) => {
      if (tracking) {
        if (Object.keys(hostnameCache).length) {
          post('https://api.wappalyzer.com/ping/v1/', hostnameCache);
        }

        if (adCache.length) {
          post('https://ad.wappalyzer.com/log/wp/', adCache);
        }

        setOption('robotsTxtCache', {});
      }
    });
};
