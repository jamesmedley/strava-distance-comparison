require('dotenv').config();
const path = require('path');
const fetch = require('node-fetch');
const strava_api = require('./strava_api.js');
var admin = require("firebase-admin");
const firebase = require('firebase');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json())

var serviceAccount = require("../strava-distance-comparison-firebase-adminsdk-koc68-e74752edd8.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.DB_DATABASE_URL
});

require('firebase/auth')
const firebaseConfig = {
  apiKey: process.env.DB_APIKEY,
  authDomain: process.env.DB_AUTH_DOMAIN,
  databaseURL: process.env.DB_DATABASE_URL,
  projectId: process.env.DB_PROJECT_ID,
  storageBucket: process.env.DB_STORAGE_BUCKET,
  messagingSenderId: process.env.DB_MESSAGING_SENDER_ID,
  appId: process.env.DB_APP_ID,
};

firebase.initializeApp(firebaseConfig);

//connect to cities db
const { MongoClient } = require('mongodb');
const uri = 'mongodb://localhost:27017'; //heroku PaaS
const client = new MongoClient(uri);

async function find_closest_match(distance) {
    try {
        await client.connect();

        const database = client.db('city_distances');
        const collection = database.collection('strava-distances-comparison');
        const queryValue = distance;

        const result = await collection
            .find({ distance: { $gte: queryValue } })
            .sort({ distance: 1 })
            .limit(1)
            .toArray();

        return result;
    } finally {
        await client.close();
    }
}


async function deleteStravaWebhook(sub_id){
  const subscriptionUrl = `https://www.strava.com/api/v3/push_subscriptions/${sub_id}`;
  const requestOptions = {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET
    }),
  };
  try {
    const response = await fetch(subscriptionUrl, requestOptions);
    if (response.ok) {
      console.log('Webhook subscription successfully deleted.');
    } else {
      const responseData = await response.json();
      console.error('Failed to delete webhook subscription:', responseData);
    }
  } catch (error) {
    console.error('Error deleting webhook subscription:', error);
  }
}


async function viewStravaWebhooks(){
  const subscriptionUrl = `https://www.strava.com/api/v3/push_subscriptions/?client_id=${process.env.CLIENT_ID}&client_secret=${process.env.CLIENT_SECRET}`;
  const requestOptions = {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  };
  try {
    const response = await fetch(subscriptionUrl, requestOptions);
    if (response.ok) {
      const responseData = await response.json();
      console.log('Webhook subscriptions successfully received:');
      console.log(responseData);
    } else {
      console.error('Failed to retrieve webhook subscriptions:', response.statusText);
    }
  } catch (error) {
    console.error('Error retrieving webhook subscriptions:', error);
  }
}

async function createStravaWebhook() {
  const subscriptionUrl = 'https://www.strava.com/api/v3/push_subscriptions';
  const callbackUrl = 'https://ef72-2a04-203-74b8-100-c2f-ea76-4ff9-e7d6.ngrok.io/webhook'; //temporary ngrok public domain
  await viewStravaWebhooks()
  await deleteStravaWebhook(process.env.WEBHOOK_ID)
  const requestOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      callback_url: callbackUrl,
      verify_token: process.env.WEBHOOK_VERIFY_TOKEN,
    }),
  };

  try {
    const response = await fetch(subscriptionUrl, requestOptions);
    if (response.ok) {
      const responseData = await response.json();
      process.env.WEBHOOK_ID = responseData.id
      console.log('Webhook subscription created:', responseData);
    } else {
      console.error('Failed to create webhook subscription:', response.statusText);
    }
  } catch (error) {
    console.error('Error creating webhook subscription:', error);
  }
}
//createStravaWebhook(); // create strava webhook


async function isBikeRide(activity_id, athlete_id){
  const userRef = admin.database().ref(`/users/${athlete_id}`);
  try {
    const snapshot = await userRef.once("value");
    const userData = snapshot.val();
    const refresh_token = userData.refreshToken;
    const ride = await strava_api.getActivityType(refresh_token, activity_id);
    return ride == "Ride";
  } catch (error) {
    console.error("Error reading data:", error);
    throw error;
  }
}


async function getOverallRideDistance(athlete_id) {
  const userRef = admin.database().ref(`/users/${athlete_id}`);
  try {
    const snapshot = await userRef.once("value");
    const userData = snapshot.val();
    const refresh_token = userData.refreshToken;
    const rideTotal = await strava_api.getAthleteRideTotal(refresh_token, athlete_id);
    return rideTotal;
  } catch (error) {
    console.error("Error reading data:", error);
    throw error;
  }
}


async function updateDescription(activity_id, athlete_id){
  const userRef = admin.database().ref(`/users/${athlete_id}`);
  try {
    const snapshot = await userRef.once("value");
    const userData = snapshot.val();
    const refresh_token = userData.refreshToken;
    const distance = await getOverallRideDistance(athlete_id)
    const city_api_url = `http://localhost:3000/api/city-separation-distance?distance=${distance}`;
    try {
      const response = await fetch(city_api_url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      if (response.ok) {
        const city_data = await response.json();
        city1 = city_data[0].city1
        city2 = city_data[0].city2
        const description = `You have now cycled ${distance}km on Strava. That's the equivalent of cycling from 📍${city1} to 📍${city2}`;
        await strava_api.updateDescription(refresh_token, activity_id, description);
      } else {
        throw new Error(`Failed to fetch data: ${response.statusText}`);
      }
    } catch (error) {
      console.error('Error fetching data:', error);
      throw error;
    }
  } catch (error) {
    console.error("Error reading data:", error);
    throw error;
  }
}


function authenticateMiddleware(req, res, next) {
    const user = firebase.auth().currentUser;
  
    if (user) {
      req.user = user;
      next();
    } else {
      res.status(401).json({ message: 'Unauthorized' });
    }
  }


app.get('/api/city-separation-distance', async (req, res) => {
    const { distance } = req.query;
    try {
      const result = await find_closest_match(Number(distance));
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
});


app.get('/google-signin', (req, res) => {
    const provider = new firebase.auth.GoogleAuthProvider();
    
    // You can customize the permissions you request from the user here
    // provider.addScope('https://www.googleapis.com/auth/plus.login');
    
    firebase.auth().signInWithPopup(provider)
      .then((result) => {
        // Google Sign-In successful, result.user contains user info
        res.redirect('/dashboard'); // Redirect to a protected route or dashboard
      })
      .catch((error) => {
        res.status(401).json({ message: 'Google Sign-In failed', error: error.message });
      });
});


app.post('/register', (req, res) => {
    const { email, password } = req.body;

    firebase
      .auth()
      .createUserWithEmailAndPassword(email, password)
      .then((userCredential) => {
        const user = userCredential.user;
        res.status(201).json({ message: 'Registration successful', user });
      })
      .catch((error) => {
        res.status(400).json({ message: 'Registration failed', error: error.message });
      });
});


app.post('/login', (req, res) => {
    const { email, password } = req.body;
    
    firebase
      .auth()
      .signInWithEmailAndPassword(email, password)
      .then((userCredential) => {
        const user = userCredential.user;
        res.status(200).json({ message: 'Login successful', user });
      })
      .catch((error) => {
        res.status(401).json({ message: 'Login failed', error: error.message });
      });
});


app.post('/logout', (req, res) => {
    firebase
      .auth()
      .signOut()
      .then(() => {
        res.status(200).json({ message: 'Logout successful' });
      })
      .catch((error) => {
        res.status(500).json({ message: 'Logout failed', error: error.message });
      });
});


app.get('/dashboard', authenticateMiddleware, (req, res) => {
    const dashboardPath = path.join(__dirname, '..', 'public', 'dashboard.html');
    res.sendFile(dashboardPath);
});


app.get('/strava-auth', authenticateMiddleware, (req, res) =>{
  const stravaAuthUrl = `http://www.strava.com/oauth/authorize?client_id=${process.env.CLIENT_ID}&response_type=code&redirect_uri=http://localhost:3000/exchange_token&approval_prompt=force&scope=read,activity:write,activity:read`;
  res.redirect(stravaAuthUrl);
});


app.get('/exchange_token', authenticateMiddleware, async (req, res) => {
    const authorizationCode = req.query.code;
    if(req.query.scope != 'read,activity:write,activity:read'){
      res.redirect('/strava-auth');
      return;
    }
    const tokenExchangeUrl = 'https://www.strava.com/oauth/token';
    const requestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        code: authorizationCode,
        grant_type: 'authorization_code',
      }),
    };
    try {
      const response = await fetch(tokenExchangeUrl, requestOptions);
      const data = await response.json();
      if (response.ok) {
        const accessToken = data.access_token;
        const refreshToken = data.refresh_token;
        const athleteID = data.athlete.id;
        const athleteUsername = data.athlete.username;
    
        const userUID = req.user.uid;

        const userRef = admin.database().ref(`/users/${athleteID}`);
        await userRef.set({
          accessToken,
          refreshToken,
          userUID,
          athleteUsername,
        });
        res.redirect('/dashboard');
      } else {
        console.error('Token exchange failed:', data);
        res.status(500).json({ error: 'Token exchange failed' });
      }
    } catch (error) {
      console.error('Token exchange error:', error);
      res.status(500).json({ error: 'Token exchange error' });
    }
});


app.post('/webhook', async (req, res) => {
  console.log("webhook event received!", req.query, req.body);
  res.status(200).send('EVENT_RECEIVED');
  if(req.body.aspect_type == 'create' && req.body.object_type == 'activity'){
    const activity_id = req.body.object_id;
    const athlete_id = req.body.owner_id;
    if(await isBikeRide(activity_id, athlete_id)){
      await updateDescription(activity_id, athlete_id);
    }   
  }
})


app.get('/webhook', (req, res) => {
  // Your verify token. Should be a random string.
  const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
  // Parses the query params
  let mode = req.query['hub.mode'];
  let token = req.query['hub.verify_token'];
  let challenge = req.query['hub.challenge'];
  // Checks if a token and mode is in the query string of the request
  if (mode && token) {
    // Verifies that the mode and token sent are valid
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {     
      // Responds with the challenge token from the request
      console.log('WEBHOOK_VERIFIED');
      res.json({"hub.challenge":challenge});  
    } else {
      // Responds with '403 Forbidden' if verify tokens do not match
      res.sendStatus(403);      
    }
  }
});
  

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});