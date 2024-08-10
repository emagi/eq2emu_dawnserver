const axios = require('axios');
const https = require('https');
const fs = require('fs');

const httpsAgent = new https.Agent({
  cert: fs.readFileSync('/eq2emu/eq2emu/server/webcert.pem'),
  rejectUnauthorized: false
})

const fetchStatus = async (url, username, password) => {
  try {
    const response = await axios.get(url, {
      httpsAgent,
      auth: {
        username: username,
        password: password
      },
      withCredentials: true
    });

    // Assuming the JSON response contains a 'status' field
    const status = response.data;
    return status;
  } catch (error) {
    return null;
  }
};

module.exports = fetchStatus;