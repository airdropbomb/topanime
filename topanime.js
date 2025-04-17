       console.log(`
       █████╗ ██████╗ ██████╗     ███╗   ██╗ ██████╗ ██████╗ ███████╗
      ██╔══██╗██╔══██╗██╔══██╗    ████╗  ██║██╔═══██╗██╔══██╗██╔════╝
      ███████║██║  ██║██████╔╝    ██╔██╗ ██║██║   ██║██║  ██║█████╗  
      ██╔══██║██║  ██║██╔══██╗    ██║╚██╗██║██║   ██║██║  ██║██╔══╝  
      ██║  ██║██████╔╝██████╔╝    ██║ ╚████║╚██████╔╝██████╔╝███████╗
      ╚═╝  ╚═╝╚═════╝ ╚═════╝     ╚═╝  ╚═══╝ ╚═════╝ ╚═════╝ ╚══════╝
       `);

const puppeteerCore = require('puppeteer-core');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Read multiple accounts from data.txt
const data = fs.readFileSync('data.txt', 'utf8').trim();
const accounts = data.split('\n').map(line => {
    const [username, password, proxy] = line.split('|');
    return { username, password, proxy };
});

// Function to detect if running in Termux
const isTermux = process.env.TERMUX_VERSION !== undefined;

// Custom delay function
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Function to log messages with timestamp
const log = (message) => {
    console.log(`[${new Date().toISOString()}] ${message}`);
};

// Ensure the anime-cookies directory exists
const cookiesDir = path.join(__dirname, 'anime-cookies');
if (!fs.existsSync(cookiesDir)) {
    fs.mkdirSync(cookiesDir);
    log(`Created directory: ${cookiesDir}`);
}

// Function to save cookies to a file in anime-cookies folder
const saveCookies = async (cookies, username) => {
    const cookieFile = path.join(cookiesDir, `cookies-${username}.json`);
    fs.writeFileSync(cookieFile, JSON.stringify(cookies, null, 2));
    log(`Cookies saved to ${cookieFile}`);
};

// Function to load cookies from a file in anime-cookies folder
const loadCookies = (username) => {
    const cookieFile = path.join(cookiesDir, `cookies-${username}.json`);
    if (fs.existsSync(cookieFile)) {
        return JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
    }
    return null;
};

// Function to login and return cookies and CSRF token
const loginToMyAnimeList = async (page, account) => {
    log(`Navigating to login page for ${account.username}...`);
    await page.goto('https://myanimelist.net/login.php?from=%2Ftopanime.php', {
        waitUntil: 'networkidle2',
        timeout: 90000
    });

    // Handle GDPR consent dialog if present
    const consentButton = await page.$('button[mode="primary"]');
    if (consentButton) {
        log(`Consent dialog found for ${account.username}, clicking 'AGREE'...`);
        await consentButton.click();
        await delay(2000);
    }

    // Type username and password
    log(`Entering credentials for ${account.username}...`);
    await page.waitForSelector('input#loginUserName', { timeout: 60000 });
    await page.type('input#loginUserName', account.username);
    await page.type('input#login-password', account.password);

    // Click login button
    await page.waitForSelector('input[type="submit"]', { timeout: 60000 });
    await page.click('input[type="submit"]');

    // Wait for navigation and check login status
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 });

    // Check for login error
    const loginError = await page.evaluate(() => {
        const errorElement = document.querySelector('.badresult-text');
        return errorElement ? errorElement.textContent.trim() : null;
    });

    if (loginError) {
        throw new Error(`Login failed for ${account.username}: ${loginError}`);
    }

    log(`Login successful for ${account.username}`);

    // Extract cookies and CSRF token
    const cookies = await page.cookies();
    const csrfToken = await page.evaluate(() => {
        const meta = document.querySelector('meta[name="csrf_token"]');
        return meta ? meta.getAttribute('content') : null;
    });

    // Save cookies to file in anime-cookies folder
    await saveCookies(cookies, account.username);

    return { cookies, csrfToken };
};

// Function to check if session is valid
const checkSession = async (page, account) => {
    log(`Checking session for ${account.username}...`);
    await page.goto('https://myanimelist.net/topanime.php', { waitUntil: 'networkidle2', timeout: 90000 });
    const currentUrl = await page.url();
    if (currentUrl.includes('login.php')) {
        log(`Session invalid for ${account.username}, need to re-login...`);
        return false;
    }
    log(`Session valid for ${account.username}`);
    return true;
};

// Function to add anime to list with retries
const addAnimeToList = async (page, account, animeId, attempt) => {
    const addToListUrl = `https://myanimelist.net/ownlist/anime/add?selected_series_id=${animeId}&hideLayout=1&click_type=anime_ranking`;
    log(`Attempt ${attempt} to add anime (ID: ${animeId}) for ${account.username}...`);

    // Retry navigation up to 3 times
    let response = null;
    for (let navRetry = 1; navRetry <= 3; navRetry++) {
        try {
            response = await page.goto(addToListUrl, { waitUntil: 'networkidle2', timeout: 90000 });
            break;
        } catch (error) {
            log(`Navigation attempt ${navRetry} failed for anime (ID: ${animeId}): ${error.message}`);
            if (navRetry === 3) throw error;
            await delay(5000);
        }
    }

    // Check for redirect to login page (session invalid)
    let currentUrl = await page.url();
    if (currentUrl.includes('login.php')) {
        log(`Session invalid, re-logging in for ${account.username}...`);
        await loginToMyAnimeList(page, account);
        for (let navRetry = 1; navRetry <= 3; navRetry++) {
            try {
                response = await page.goto(addToListUrl, { waitUntil: 'networkidle2', timeout: 90000 });
                break;
            } catch (error) {
                log(`Navigation attempt ${navRetry} failed after re-login for anime (ID: ${animeId}): ${error.message}`);
                if (navRetry === 3) throw error;
                await delay(5000);
            }
        }
        currentUrl = await page.url();
    }

    // Check for redirect to edit page (indicating anime already added)
    if (currentUrl.includes('edit')) {
        log(`Redirected to edit page (${currentUrl}), anime (ID: ${animeId}) is already added`);
        return false; // Skip this attempt
    }

    // Verify we're on the correct page
    if (!currentUrl.includes('ownlist/anime/add')) {
        log(`Session invalid (attempt ${attempt}): Redirected to ${currentUrl}`);
        return false; // Skip screenshot to avoid clutter
    }

    // Wait for dialog to load
    try {
        await page.waitForSelector('div.normal_header', { timeout: 60000 });
    } catch (error) {
        log(`Dialog failed to load (attempt ${attempt})`);
        return false; // Skip screenshot
    }

    // Wait for the bottom submit button and ensure it's visible
    const submitButtonSelector = 'input[class="inputButton main_submit"][value="Submit"]';
    let submitButton = null;

    // Retry to find a visible button
    for (let retry = 1; retry <= 5; retry++) {
        log(`Retry ${retry}: Searching for visible Submit button...`);
        const buttons = await page.$$(submitButtonSelector);
        for (const btn of buttons) {
            const isVisible = await page.evaluate((el) => {
                const style = window.getComputedStyle(el);
                return style.display !== 'none' && el.offsetParent !== null;
            }, btn);

            if (isVisible) {
                submitButton = btn;
                break;
            }
        }

        if (submitButton) break;

        log(`Retry ${retry}: No visible Submit button found, waiting...`);
        await delay(3000);
    }

    if (!submitButton) {
        log(`Submit button not found (attempt ${attempt})`);
        return false; // Skip screenshot
    }

    // Click the submit button
    let clicked = false;
    for (let retry = 1; retry <= 3; retry++) {
        log(`Retry ${retry}: Attempting to click Submit button...`);
        clicked = await page.evaluate((btn) => {
            if (btn && btn.offsetParent !== null) {
                btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                btn.click();
                return true;
            }
            return false;
        }, submitButton);

        if (clicked) break;

        log(`Retry ${retry}: Submit button not interactable, waiting...`);
        await delay(2000);
    }

    if (!clicked) {
        throw new Error(`Submit button not clicked after retries (attempt ${attempt})`);
    }

    await delay(5000); // Increased delay after submission to avoid rate limiting

    // Check if dialog is still open and close it
    const dialogStillOpen = await page.evaluate(() => {
        return document.querySelector('div.normal_header') !== null;
    });

    if (dialogStillOpen) {
        const closeButton = await page.$('a.close');
        if (closeButton) {
            log(`Closing dialog for ${account.username}...`);
            await closeButton.click();
            await delay(1000);
        }
    }

    log(`Attempt ${attempt} completed for ${account.username}`);
    return true;
};

// Function to scrape anime IDs and check for "Add to list" buttons
const scrapeAnimeList = async (page, pageNumber) => {
    const limit = (pageNumber - 1) * 50;
    const url = `https://myanimelist.net/topanime.php?limit=${limit}`;
    log(`Scraping anime list from Top Anime Series page ${pageNumber} (URL: ${url})...`);

    // Retry navigation for scraping
    for (let navRetry = 1; navRetry <= 3; navRetry++) {
        try {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
            break;
        } catch (error) {
            log(`Navigation attempt ${navRetry} failed for page ${pageNumber}: ${error.message}`);
            if (navRetry === 3) throw error;
            await delay(5000);
        }
    }

    const animeList = await page.evaluate(() => {
        const animeRows = document.querySelectorAll('tr.ranking-list');
        const animeData = [];

        animeRows.forEach(row => {
            const titleElement = row.querySelector('h3.anime_ranking_h3 a');
            const statusButton = row.querySelector('a.btn-addEdit-large.btn-anime-watch-status.js-anime-watch-status');

            if (titleElement && statusButton) {
                const title = titleElement.textContent.trim();
                const href = titleElement.getAttribute('href');
                const idMatch = href.match(/anime\/(\d+)/);
                const animeId = idMatch ? parseInt(idMatch[1]) : null;

                // Check if the anime is already added (e.g., "Watching", "Completed", or lacks "notinmylist")
                const isNotInList = statusButton.classList.contains('notinmylist');
                const statusText = statusButton.textContent.trim().toLowerCase();

                if (animeId && isNotInList && statusText === 'add to list') {
                    animeData.push({ id: animeId, title, alreadyAdded: false });
                } else {
                    animeData.push({ id: animeId, title, alreadyAdded: true, status: statusText });
                }
            }
        });

        return animeData;
    });

    // Log anime that are already added
    const alreadyAdded = animeList.filter(anime => anime.alreadyAdded);
    if (alreadyAdded.length > 0) {
        log(`Already added to list on page ${pageNumber}: ${alreadyAdded.map(a => `${a.title} (ID: ${a.id}, Status: ${a.status})`).join(', ')}`);
    }

    const toAdd = animeList.filter(anime => !anime.alreadyAdded);
    log(`Found ${toAdd.length} anime(s) to add on page ${pageNumber}: ${toAdd.map(a => `${a.title} (ID: ${a.id})`).join(', ')}`);
    return animeList;
};

// Main function to process accounts and add anime
(async () => {
    let browser;

    try {
        // Process each account
        for (const account of accounts) {
            const browserArgs = [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--window-size=1920,1080'
            ];

            // Add proxy if specified
            if (account.proxy) {
                log(`Using proxy ${account.proxy} for ${account.username}`);
                browserArgs.push(`--proxy-server=${account.proxy}`);
            } else {
                log(`No proxy specified for ${account.username}`);
            }

            // Launch browser based on environment
            if (isTermux) {
                log('Running in Termux...');
                browser = await puppeteerCore.launch({
                    headless: true,
                    executablePath: 'chromium',
                    args: browserArgs
                });
            } else {
                log('Running in VPS...');
                browser = await puppeteer.launch({
                    headless: true,
                    args: browserArgs,
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                });
            }

            const page = await browser.newPage();

            // If proxy requires authentication, set it here
            if (account.proxy && account.proxy.includes('@')) {
                const [proxyAuth, proxyServer] = account.proxy.split('@');
                const [proxyUser, proxyPass] = proxyAuth.replace('http://', '').split(':');
                await page.authenticate({
                    username: proxyUser,
                    password: proxyPass
                });
            }

            try {
                log(`Processing account: ${account.username}`);
                await page.setViewport({ width: 1920, height: 1080 });

                // Always login to ensure fresh session
                log(`Logging in for ${account.username} to ensure fresh session...`);
                await loginToMyAnimeList(page, account);

                // Process 6 pages or until 300 tasks are completed
                const maxTasks = 300;
                const pagesToProcess = 6;
                let totalTasks = 0;

                for (let pageNumber = 1; pageNumber <= pagesToProcess; pageNumber++) {
                    // Scrape anime list from the current page
                    const animeList = await scrapeAnimeList(page, pageNumber);

                    // Add each anime to the list
                    for (const anime of animeList) {
                        if (totalTasks >= maxTasks) {
                            log(`Reached ${maxTasks} tasks. Stopping for ${account.username}.`);
                            break;
                        }

                        // Increment task count for every anime processed
                        totalTasks++;

                        if (anime.alreadyAdded) {
                            log(`Task ${totalTasks}/${maxTasks} completed for ${account.username}: Skipped anime (ID: ${anime.id}, ${anime.title}) - already add to list (Status: ${anime.status})`);
                            continue; // Skip this anime
                        }

                        let addedSuccessfully = false;
                        for (let attempt = 1; attempt <= 2; attempt++) {
                            try {
                                // Check session before each attempt
                                const sessionValid = await checkSession(page, account);
                                if (!sessionValid) {
                                    log(`Re-logging in due to invalid session for ${account.username}...`);
                                    await loginToMyAnimeList(page, account);
                                }

                                const success = await addAnimeToList(page, account, anime.id, attempt);
                                if (!success) {
                                    log(`Skipping attempt ${attempt} for anime (ID: ${anime.id}, ${anime.title}) as it is already added`);
                                    break;
                                }

                                addedSuccessfully = true;
                                break; // Move to the next anime if successful
                            } catch (error) {
                                log(`Error adding anime (ID: ${anime.id}, ${anime.title}) on attempt ${attempt} for ${account.username}: ${error.message}`);
                                if (attempt === 2) {
                                    log(`Failed to add anime (ID: ${anime.id}, ${anime.title}) after all attempts for ${account.username}`);
                                }
                            }
                        }

                        if (addedSuccessfully) {
                            log(`Task ${totalTasks}/${maxTasks} completed for ${account.username}: Added anime (ID: ${anime.id}, ${anime.title})`);
                        }

                        // Add delay to avoid rate limiting
                        await delay(5000);
                    }

                    if (totalTasks >= maxTasks) {
                        break;
                    }

                    log(`All tasks completed for page ${pageNumber} for ${account.username}. Moving to next page...`);
                }

                log(`All tasks completed for ${account.username}. Total tasks: ${totalTasks}`);
            } catch (error) {
                log(`Error with ${account.username}: ${error.message}`);
            } finally {
                await page.close();
            }

            // Close browser after each account to avoid conflicts
            await browser.close();
            browser = null;
        }
    } catch (error) {
        log(`Browser error: ${error.message}`);
    } finally {
        if (browser) {
            log('Closing browser...');
            await browser.close();
        }

        // Clean up unnecessary error files
        log('Cleaning up unnecessary error files...');
        const files = fs.readdirSync(__dirname);
        files.forEach(file => {
            if (file.startsWith('error-') && file.endsWith('.png')) {
                const filePath = path.join(__dirname, file);
                fs.unlinkSync(filePath);
                log(`Deleted file: ${filePath}`);
            }
        });
    }
})();
