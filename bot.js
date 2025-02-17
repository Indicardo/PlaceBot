import "dotenv/config";
import fetch from 'node-fetch';
import getPixels from "get-pixels";
import WebSocket from 'ws';
import https from 'https'

const VERSION_NUMBER = 7;

console.log(`Overcast Place Bot headless client V${VERSION_NUMBER}`);

const args = process.argv.slice(2);

let redditSessionCookies = (process.env.REDDIT_SESSION || args[0])
if (redditSessionCookies) redditSessionCookies = redditSessionCookies.split(';')

let usernames = (process.env.BOT_USERNAME || false)
if (usernames) usernames = usernames.split(';');

let passwords = (process.env.BOT_PASSWORD || false)
if (passwords) passwords = passwords.split(';');

if (usernames || passwords) {
    if (usernames?.length !== passwords?.length) {
        console.error('Introduce one user per password (and vice versa).');
        usernames = false;
        passwords = false;
    }
}
if (!(redditSessionCookies || (usernames && passwords))) {
    console.error("Missing credentials cookie.")
    process.exit(1);
}
if(!redditSessionCookies) redditSessionCookies = [];

var hasTokens = false;

let accessTokens;
let defaultAccessToken;

if (redditSessionCookies.length > 4) {
    console.warn("Using more than 4 reddit accounts per IP address is not recommended!")
}

var socket;
var currentOrders;
var currentOrderList;

const COLOR_MAPPINGS = {
    '#6D001A': 0,
    '#BE0039': 1,
    '#FF4500': 2,
    '#FFA800': 3,
    '#FFD635': 4,
    '#FFF8B8': 5,
    '#00A368': 6,
    '#00CC78': 7,
    '#7EED56': 8,
    '#00756F': 9,
    '#009EAA': 10,
    '#00CCC0': 11,
    '#2450A4': 12,
    '#3690EA': 13,
    '#51E9F4': 14,
    '#493AC1': 15,
    '#6A5CFF': 16,
    '#94B3FF': 17,
    '#811E9F': 18,
    '#B44AC0': 19,
    '#E4ABFF': 20,
    '#DE107F': 21,
    '#FF3881': 22,
    '#FF99AA': 23,
    '#6D482F': 24,
    '#9C6926': 25,
    '#FFB470': 26,
    '#000000': 27,
    '#515252': 28,
    '#898D90': 29,
    '#D4D7D9': 30,
    '#FFFFFF': 31
};

function rgbaJoinH(a1, a2, rowSize = 1000, cellSize = 4) {
    const rawRowSize = rowSize * cellSize;
    const rows = a1.length / rawRowSize;
    let result = new Uint8Array(a1.length + a2.length);
    for (var row = 0; row < rows; row++) {
        result.set(a1.slice(rawRowSize * row, rawRowSize * (row + 1)), rawRowSize * 2 * row);
        result.set(a2.slice(rawRowSize * row, rawRowSize * (row + 1)), rawRowSize * (2 * row + 1));
    }
    return result;
};

function rgbaJoinV(a1, a2, rowSize = 2000, cellSize = 4) {
    let result = new Uint8Array(a1.length + a2.length);

    const rawRowSize = rowSize * cellSize;

    const rows1 = a1.length / rawRowSize;

    for (var row = 0; row < rows1; row++) {
        result.set(a1.slice(rawRowSize * row, rawRowSize * (row+1)), rawRowSize * row);
    }

    const rows2 = a2.length / rawRowSize;

    for (var row = 0; row < rows2; row++) {
        result.set(a2.slice(rawRowSize * row, rawRowSize * (row+1)), (rawRowSize * row) + a1.length);
    }

    return result;
};

function getRealWork(rgbaOrder){
    let order = [];
    for (var i = 0; i < 4000000; i++) {
        if (rgbaOrder[(i * 4) + 3] !== 0) {
            order.push(i);
        }
    }
    return order;
};

function getPendingWork(work, rgbaOrder, rgbaCanvas) {
    let pendingWork = [];
    for (const i of work) {
        if (rgbaOrderToHex(i, rgbaOrder) !== rgbaOrderToHex(i, rgbaCanvas)) {
            pendingWork.push(i);
        }
    }
    return pendingWork;
};

(async function () {
    await refreshTokens(); // wachten totdat je de tokens hebt (duurt nu langer);

    connectSocket();
    startPlacement();

    setInterval(() => {
        if (socket) socket.send(JSON.stringify({ type: 'ping' }));
    }, 5000);
    // Refresh de tokens elke 30 minuten. Moet genoeg zijn toch.
    setInterval(refreshTokens, 30 * 60 * 1000);
})();

function startPlacement() {
    if (!hasTokens) {
        // Probeer over een seconde opnieuw.
        setTimeout(startPlacement, 10000);
        return
    }

    // Try to stagger pixel placement
    const interval = 300 / accessTokens.length;
    var delay = 0;
    for (const accessToken of accessTokens) {
        setTimeout(() => attemptPlace(accessToken), delay * 1000);
        delay += interval;
    }
}


function request(options, body) {
    let promise = new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            resolve(res);
        });

        req.on('error', (e) => {
            reject(error);
        });
        if (body) {
            req.write(body); //stuurd de pass en username
        }
        req.end();
    });
    return promise
}

async function getToken(username, password) {
    let placeUrl = "https://www.reddit.com/r/place/"
    let redditUrl = "https://www.reddit.com/login/"
    let response = await fetch(redditUrl); //pak de csrf token van de login form (ook nodig voor sesion cookie)
    let responseText = await response.text();

    let csrf = responseText.match(/csrf_token" value\="(.*?)">/)[1]; // crsf token

    let cookies = response.headers.raw()['set-cookie']; //alle cookie
    let session = cookies[0].match(/session\=(.*?;)/)[1]; // eerste is altijd (hoop ik) de session cookie

    let body = `csrf_token=${csrf}&password=${password}&username=${username}`; //body van login request

    const options = {
        hostname: 'www.reddit.com',
        port: 443,
        path: '/login',
        method: 'POST',
        headers: {
            'cookie': `session=${session}`, //login request heeft session cookie nodig (van de eerde login form)
        }
    };

    //node fetch werkt hier niet want die set bepalde header die niet mogen geset worden
    let result = await request(options, body);
    let cookieRedditSession;
    try {
        cookieRedditSession = result.headers['set-cookie'][0].match(/reddit_session\=(.*?);/)[1]; //reddit_session cookie
    } catch (e) {
        console.error("[!!] Set-cookie header not found. Wrong username password combination");
    }
    
    response = await fetch(placeUrl, {
        headers: {
            cookie: `reddit_session=${cookieRedditSession}`
        }
    })
    
    responseText = await response.text();

    return responseText.split('\"accessToken\":\"')[1].split('"')[0];
}

async function refreshTokens() {
    let tokens = [];
    if (usernames && passwords) {
        for (let i = 0; i < usernames.length; i++) {
            let username = usernames[i];
            let password = passwords[i];
            console.log(`Getting reddit session token for ${username}`);
            let token = await getToken(username, password);
            tokens.push(token);
        }
        console.log("Refreshed tokens: ", tokens)

        accessTokens = tokens;
        defaultAccessToken = tokens[0];
        hasTokens = true;
        return
    }

    for (const cookie of redditSessionCookies) {
        const response = await fetch("https://www.reddit.com/r/place/", {
            headers: {
                cookie: `reddit_session=${cookie}`
            }
        });
        const responseText = await response.text()

        let token = responseText.split('\"accessToken\":\"')[1].split('"')[0];
        tokens.push(token);
    }

    console.log("Refreshed tokens: ", tokens)

    accessTokens = tokens;
    defaultAccessToken = tokens[0];
    hasTokens = true;
}

function connectSocket() {
    console.log('Connecting to Overcast Place Bot server...')

    socket = new WebSocket('wss://placebot.oc.tc/api/ws');

    socket.onerror = (e) => {
        console.error("Socket error: " + e.message)
    }

    socket.onopen = () => {
        console.log('Connected to the Overcast Place Bot server!')
        socket.send(JSON.stringify({ type: 'getmap' }));
        socket.send(JSON.stringify({ type: 'brand', brand: `nodeheadlessV${VERSION_NUMBER}` }));
    };

    socket.onmessage = async function(message) {
        var data;
        try {
            data = JSON.parse(message.data);
        } catch (e) {
            return;
        }

        switch (data.type.toLowerCase()) {
            case 'map':
                console.log(`New folder loaded (reason: ${data.reason ? data.reason : 'connected to server'})`)
                currentOrders = await getMapFromUrl(`https://placebot.oc.tc/maps/${data.data}`);
                currentOrderList = getRealWork(currentOrders.data);
                break;
            default:
                break;
        }
    };

    socket.onclose = (e) => {
        console.warn(`Overcast Place Bot server has disconnected: ${e.reason}`)
        console.error('Socketfout: ', e.reason);
        socket.close();
        setTimeout(connectSocket, 1000);
    };
}

async function attemptPlace(accessToken) {
    let retry = () => attemptPlace(accessToken);
    if (!currentOrderList) {
        setTimeout(retry, 10000); // probeer opnieuw in 2sec.
        return;
    }

    var map0;
    var map1;
    var map2;
    var map3;
    try {
        map0 = await getMapFromUrl(await getCurrentImageUrl('0'));
        map1 = await getMapFromUrl(await getCurrentImageUrl('1'));
        map2 = await getMapFromUrl(await getCurrentImageUrl('2'));
        map3 = await getMapFromUrl(await getCurrentImageUrl('3'));
    } catch (e) {
        console.warn('Error retrieving folder: ', e);
        setTimeout(retry, 15000); // probeer opnieuw in 15sec.
        return;
    }

    const rgbaOrder = currentOrders.data;
    const rgbaCanvasH0 = rgbaJoinH(map0.data, map1.data);
    const rgbaCanvasH1 = rgbaJoinH(map2.data, map3.data);
    const rgbaCanvas = rgbaJoinV(rgbaCanvasH0, rgbaCanvasH1);
    const work = getPendingWork(currentOrderList, rgbaOrder, rgbaCanvas);

    if (!work.length) {
        console.log(`All pixels are already in the right place! Trying again in 30 seconds...`);
        setTimeout(retry, 30000); // probeer opnieuw in 30sec.
        return;
    }

    const percentComplete = 100 - Math.ceil(work.length * 100 / currentOrderList.length);
    const workRemaining = work.length;
    const idx = Math.floor(Math.random() * work.length);
    const i = work[idx];
    const x = i % 2000;
    const y = Math.floor(i / 2000);
    const hex = rgbaOrderToHex(i, rgbaOrder);

    console.log(`Trying to place pixel on ${x}, ${y}... (${percentComplete}% complete, ${workRemaining} left)`);

    const res = await place(x, y, COLOR_MAPPINGS[hex], accessToken);
    const data = await res.json();
    try {
        if (data.errors) {
            const error = data.errors[0];
            if (error.extensions && error.extensions.nextAvailablePixelTimestamp ||  error.extensions.nextAvailablePixelTs) {
                const nextPixel = ( error.extensions.nextAvailablePixelTimestamp || error.extensions.nextAvailablePixelTs) + 3000;
                const nextPixelDate = new Date(nextPixel);
                const delay = nextPixelDate.getTime() - Date.now();
                console.log(`Pixel posted too soon! Next pixel is placed at ${nextPixelDate.toLocaleTimeString()}.`)
                setTimeout(retry, delay);
            } else {
                console.error(`[!!] Error: ${error.message}. Did you copy the 'reddit_session' cookie correctly?`);
                setTimeout(retry, 3000);
            }
        } else {
            const nextPixel = data.data.act.data[0].data.nextAvailablePixelTimestamp + 3000;
            const nextPixelDate = new Date(nextPixel);
            const delay = nextPixelDate.getTime() - Date.now();
            console.log(`Pixel placed on ${x}, ${y}! Next pixel is placed at ${nextPixelDate.toLocaleTimeString()}.`)
            setTimeout(retry, delay);
        }
    } catch (e) {
        console.warn('Analyze response error', e);
        setTimeout(retry, 10000);
    }
}

function place(x, y, color, accessToken = defaultAccessToken) {
    socket.send(JSON.stringify({ type: 'placepixel', x, y, color }));
    return fetch('https://gql-realtime-2.reddit.com/query', {
        method: 'POST',
        body: JSON.stringify({
            'operationName': 'setPixel',
            'variables': {
                'input': {
                    'actionName': 'r/replace:set_pixel',
                    'PixelMessageData': {
                        'coordinate': {
                            'x': x % 1000,
                            'y': y % 1000
                        },
                        'colorIndex': color,
                        'canvasIndex': (x > 999 ? 1 : 0)
                    }
                }
            },
            'query': 'mutation setPixel($input: ActInput!) {\n  act(input: $input) {\n    data {\n      ... on BasicMessage {\n        id\n        data {\n          ... on GetUserCooldownResponseMessageData {\n            nextAvailablePixelTimestamp\n            __typename\n          }\n          ... on SetPixelResponseMessageData {\n            timestamp\n            __typename\n          }\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\n'
        }),
        headers: {
            'origin': 'https://hot-potato.reddit.com',
            'referer': 'https://hot-potato.reddit.com/',
            'apollographql-client-name': 'mona-lisa',
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        }
    });
}

async function getCurrentImageUrl(id = '0') {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket('wss://gql-realtime-2.reddit.com/query', 'graphql-ws', {
            headers: {
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:98.0) Gecko/20100101 Firefox/98.0",
                "Origin": "https://hot-potato.reddit.com"
            }
        });

        ws.onopen = () => {
            ws.send(JSON.stringify({
                'type': 'connection_init',
                'payload': {
                    'Authorization': `Bearer ${defaultAccessToken}`
                }
            }));

            ws.send(JSON.stringify({
                'id': '1',
                'type': 'start',
                'payload': {
                    'variables': {
                        'input': {
                            'channel': {
                                'teamOwner': 'AFD2022',
                                'category': 'CANVAS',
                                'tag': id
                            }
                        }
                    },
                    'extensions': {},
                    'operationName': 'replace',
                    'query': 'subscription replace($input: SubscribeInput!) {\n  subscribe(input: $input) {\n    id\n    ... on BasicMessage {\n      data {\n        __typename\n        ... on FullFrameMessageData {\n          __typename\n          name\n          timestamp\n        }\n      }\n      __typename\n    }\n    __typename\n  }\n}'
                }
            }));
        };

        ws.onmessage = (message) => {
            const { data } = message;
            const parsed = JSON.parse(data);

            if (parsed.type === 'connection_error') {
                console.error(`[!!] Could not load /r/place map: ${parsed.payload.message}. Is the access token no longer valid?`);
            }

            // TODO: ew
            if (!parsed.payload || !parsed.payload.data || !parsed.payload.data.subscribe || !parsed.payload.data.subscribe.data) return;

            ws.close();
            resolve(parsed.payload.data.subscribe.data.name + `?noCache=${Date.now() * Math.random()}`);
        }


        ws.onerror = reject;
    });
}

function getMapFromUrl(url) {
    return new Promise((resolve, reject) => {
        getPixels(url, (err, pixels) => {
            if (err) {
                console.log("Bad image path")
                reject()
                return
            }
            resolve(pixels);
        })
    });
}

function getCanvas(x, y) {
    if (x <= 999) {
        return y <= 999 ? 0 : 2;
    } else {
        return y <= 999 ? 1 : 3;
    }
}

function rgbToHex(r, g, b) {
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
}

function rgbaOrderToHex (i, rgbaOrder) {
    return rgbToHex(rgbaOrder[i * 4], rgbaOrder[i * 4 + 1], rgbaOrder[i * 4 + 2]);
}
