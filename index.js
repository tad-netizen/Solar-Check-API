const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/analyze', async (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: 'Address is required' });

  try {
    // Step 1: Geocode the address
    const geoRes = await fetch(
  `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${process.env.GOOGLE_API_KEY}`
);
const geoData = await geoRes.json();
console.log('Geo response:', JSON.stringify(geoData));
if (!geoData.results.length) return res.status(404).json({ error: 'Address not found', geodata: geoData });
    const { lat, lng } = geoData.results[0].geometry.location;

    // Step 2: Get solar data
    const solarRes = await fetch(
      `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&requiredQuality=LOW&key=${process.env.GOOGLE_API_KEY}`
    );
    const solarData = await solarRes.json();
    if (solarData.error) return res.status(404).json({ error: 'Solar data not found for this address' });

    const solar = solarData.solarPotential;
    const roofArea = Math.round(solar.wholeRoofStats.areaMeters2);
    const sunHours = solar.maxSunshineHoursPerYear / 365;
    const panels = solar.solarPanels?.length || Math.floor(roofArea / 2.6);
    const annualProduction = Math.round(solar.maxArrayAnnualEnergyKwh);
    const offset = Math.min(Math.round((annualProduction / 10500) * 100), 100);

    // Step 3: Score the property
    const orientationScore = sunHours > 4.5 ? 30 : sunHours > 4 ? 20 : 10;
    const areaScore = roofArea > 60 ? 35 : roofArea > 40 ? 25 : 15;
    const productionScore = annualProduction > 10000 ? 35 : annualProduction > 7000 ? 25 : 15;
    const score = orientationScore + areaScore + productionScore;

    const title = score >= 85 ? 'Excellent solar candidate' :
                  score >= 70 ? 'Strong solar candidate' :
                  score >= 55 ? 'Good solar candidate' : 'Moderate solar potential';

    const desc = score >= 85 ? 'Your roof has strong solar exposure with ample usable area for a full system.' :
                 score >= 70 ? 'Your roof is a solid candidate for solar with good production potential.' :
                 score >= 55 ? 'Your roof has good solar potential. An assessment will confirm the best setup.' :
                 'Your roof has some solar potential. Shading or orientation may limit output — an assessment would clarify.';

    const ctaHeading = score >= 55 ? 'Your roof qualifies — here\'s what to do next' :
                       'Want to know for sure? Let\'s take a look';

    // Step 4: Ask Claude to write a friendly summary
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: `You are a friendly solar consultant. Write ONE sentence (max 25 words) describing this home's solar potential. Roof area: ${roofArea}m², sun hours per day: ${sunHours.toFixed(1)}, annual production estimate: ${annualProduction} kWh, score: ${score}/100. Be encouraging and specific.`
        }]
      })
    });
    const claudeData = await claudeRes.json();
    const friendlyDesc = claudeData.content?.[0]?.text || desc;

    res.json({ score, title, desc: friendlyDesc, ctaHeading, roofArea, sunHours: sunHours.toFixed(1), annualProduction: annualProduction.toLocaleString(), panels, offset });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/', (req, res) => res.send('Solar Checker API is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
