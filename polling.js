const axios = require('axios');
const https = require('https');
const fs = require('fs');

var httpsAgent = null;
var currentCert = "";
const fetchStatus = async (url, sslFiles, username, password) => {
	if(httpsAgent == null || currentCert != sslFiles.cert) {		
		httpsAgent = new https.Agent({
		  cert: fs.readFileSync(sslFiles.cert)
		})
	}
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

const postStatus = async (url, data, sslFiles, username, password) => {
	if(httpsAgent == null || currentCert != sslFiles.cert) {		
		httpsAgent = new https.Agent({
		  cert: fs.readFileSync(sslFiles.cert)
		})
	}
  try {
    const response = await axios.post(url, data, {
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

module.exports = {
	fetchStatus,
	postStatus };