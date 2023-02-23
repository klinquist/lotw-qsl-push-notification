const axios = require('axios')
const bloomfilter = require('bloomfilter');
const moment = require('moment')
const Push = require('pushover-notifications');
const config = require('config')
const fs = require('fs').promises


let push = new Push({
    user: config.get('pushover_user_token'),
    token: config.get('pushover_app_token'),
});

const daysAgo = config.get('check_previous_days')

let getDateFromDaysAgo = () => {
    var d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString().substring(0,10)
}

let minutes = config.get('check_interval_minutes')


const sendPush = (msg) => {
    push.send({
        message: msg,
        priority: 1
    }, (err) => {
        if (err) log('Error sending push notification: ' + err);
    });
}


async function asyncForEach(array, callback) {
    for (let index = 0; index < array.length; index++) {
        await callback(array[index], index, array);
    }
}




const login = config.get('lotw_username')
const password = config.get('lotw_password')


const getUrl = (startDate) => {
    return `https://lotw.arrl.org/lotwuser/lotwreport.adi?login=${login}&password=${password}&qso_query=1&qso_qsl=no&qso_startdate=${startDate}`
}
const BLOOM_HASHES = 6;

const log = (msg) => {
    let now = moment().format('YYYY-MM-DD HH:mm:ss')
    console.log(`${now} - ${msg}`)
}


const getList = async (firstrun) => {
    return new Promise(async (resolve, reject) => {
        let qsls = []
        log('Making HTTP request...')
        let url;
        if (firstrun) {
           url = getUrl('2000-01-01')
        } else {
            url = getUrl(getDateFromDaysAgo())
        }
        let result = await axios.get(url, { timeout: 30000 }).catch((err) => {
            log('Error making HTTP request: ' + err)
        })
        if (!result || !result.data || result.status != 200) {
            return reject('no data')
        }
        //LoTW still returns an HTTP 200 with a bad password. Ha.
        //So we think you put in a bad password if we see a Password prompt on the 
        //web page.
        if (result.data.indexOf('Password:') > -1) {
            return reject('bad password')
        }
        log('Got result.')
        let data = result.data.split('\r\n')
        let qslObj = {};
        let findEndOfHeader = data.indexOf('<eoh>')
        data = data.slice(findEndOfHeader + 1).filter((str) => str !== '');
        for (let i = 0; i < data.length; i++) {
            if (data[i] == '<eor>') {
                qsls.push(qslObj)
                qslObj = {}
            }
            let regex = data[i].match(/\<(.*?)\>(.*)/)

            if (regex.length < 3) {
                continue
            }
            let keyMatch = regex[1].split(':')[0]
            let valueMatch = regex[2]

            switch (keyMatch) {
                case 'CALL':
                    qslObj.call = valueMatch
                    break;
                case 'BAND':
                    qslObj.band = valueMatch
                    break;
                case 'FREQ':
                    qslObj.freq = valueMatch
                    break;
                case 'MODE':
                    qslObj.mode = valueMatch
                    break;
                case 'QSL_RCVD':
                    qslObj.qsl_rcvd = (valueMatch == "Y")
                    break;
                case 'APP_LoTW_QSO_TIMESTAMP':
                    let tsMatch = valueMatch.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/)
                    if (tsMatch && tsMatch.length == 2) {
                        qslObj.timestamp = tsMatch[1]
                    }
            }
        }
    
        return resolve(qsls)
    })

}


const checkCountry = async (call) => {
    return new Promise(async (resolve, reject) => {
        let country;
        try {
            country = await axios.get(`https://www.hamqth.com/dxcc_json.php?callsign=${call}`)
        } catch (e) {
            log('Error checking country: ' + e)
            return resolve()
        }
        if (country && country.data && country.data.name) {
            return resolve(country.data.name)
        } else {
            return resolve()
        }
    })
}

const checkForNewQSLs = async () => {
    return new Promise(async (resolve, reject) => {
        let bloomTouched = false
        let firstrun = false
        let bf = await fs.readFile(config.get('data_file'), 'utf8').catch(() => false)
        if (!bf) {
            bloomTouched = true
            firstrun = true
            log('Creating new data file')
            bloom = new bloomfilter.BloomFilter(
                256 * 1024,
                BLOOM_HASHES
            );
        } else {
            bf = JSON.parse(bf)
            bloom = new bloomfilter.BloomFilter(bf, BLOOM_HASHES);
        }
        let list;
        try {
            list = await getList(firstrun)
        } catch (err) {
            log('Unable to get list: ' + err)
            return resolve()
        }
        let qsl = 0;
        let noqsl = 0;
        
        await asyncForEach(list, async(item) => {
            if (item.qsl_rcvd) {
                qsl++;
                let itemKey = `${item.call}-${item.timestamp}`
                if (!bloom.test(itemKey)) {
                    log('New QSL from ' + item.call)
                    if (!firstrun) { 
                        let country = await checkCountry(item.call)
                        if (country) {
                            sendPush(`New QSL from ${item.call} on ${item.band} (${item.mode}) (${country})`)
                        } else {
                            sendPush(`New QSL from ${item.call} on ${item.band} (${item.mode})`)
                        }
                    } else {
                        log('Not sending push notification for first run. This is just to get the data file populated.')
                    }
                    bloomTouched = true
                    bloom.add(itemKey)
                }
            } else {
                noqsl++;
            }
        })
        firstrun = false;
        if (bloomTouched) {
            await fs.writeFile(config.get('data_file'), JSON.stringify([].slice.call(bloom.buckets)))  
        } 
        log(`Done processing QSLs. Waiting ${minutes} minutes...`)
        
        return resolve()
    })
}



(async () => { 
    log('Checking for new QSLs...')
    await checkForNewQSLs()
    setInterval(async () => {
        log('Checking for new QSLs...')
        await checkForNewQSLs()
    }, minutes*60*1000);
})();


