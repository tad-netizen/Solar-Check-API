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
    if (!geoData.results || !geoData.results.length) {
      return res.status(404).json({ error: 'Address not found' });
    }

    const { lat, lng } = geoData.results[0].geometry.location;

    // Extract state from geocode results
    let state = 'your area';
    const addressComponents = geoData.results[0].address_components || [];
    const stateComponent = addressComponents.find(c => c.types.includes('administrative_area_level_1'));
    if (stateComponent) state = stateComponent.long_name;

    // Step 2: Get solar data
    const solarRes = await fetch(
      `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&requiredQuality=LOW&key=${process.env.GOOGLE_API_KEY}`
    );
    const solarData = await solarRes.json();

    if (solarData.error) {
      return res.status(404).json({ error: 'Solar data not found for this address' });
    }

    const solar = solarData.solarPotential;

    // Usable panel area with 0.75 practical installation factor
    const rawUsableArea = solar.maxArrayAreaMeters2 || 0;
    const usableAreaM2 = Math.round(rawUsableArea * 0.75);

    // Total roof area for reference
    const totalRoofArea = Math.round(solar.wholeRoofStats?.areaMeters2 || rawUsableArea);

    // Max sunshine hours per year
    const maxSunshineHours = solar.maxSunshineHoursPerYear || 0;

    // Sun hours per day
    const sunHoursPerDay = maxSunshineHours / 365;

    // Panel count adjusted for 0.75 factor
    const rawPanels = solar.maxArrayPanelsCount || Math.floor(rawUsableArea / 1.7);
    const panels = Math.round(rawPanels * 0.75);

    // System size in kW (400W per panel)
    const systemSizeKw = panels * 0.4;

    // Annual production in kWh
    const annualProduction = Math.round(systemSizeKw * sunHoursPerDay * 365 * 0.8);

    // Average US household uses about 10,500 kWh/year
    const offset = annualProduction > 0 ? Math.min(Math.round((annualProduction / 10500) * 100), 100) : 0;

    // Score
    const sunScore = sunHoursPerDay > 4.5 ? 30 : sunHoursPerDay > 4 ? 20 : 10;
    const areaScore = usableAreaM2 > 80 ? 35 : usableAreaM2 > 50 ? 25 : 15;
    const productionScore = annualProduction > 15000 ? 35 : annualProduction > 10000 ? 28 : annualProduction > 7000 ? 20 : 12;
    const score = Math.min(sunScore + areaScore + productionScore, 100);

    const title = score >= 85 ? 'Excellent solar candidate' :
                  score >= 70 ? 'Strong solar candidate' :
                  score >= 55 ? 'Good solar candidate' : 'Moderate solar potential';

    const desc = score >= 85 ? 'Your roof has strong solar exposure with ample usable area for a full system.' :
                 score >= 70 ? 'Your roof is a solid candidate for solar with good production potential.' :
                 score >= 55 ? 'Your roof has good solar potential. An assessment will confirm the best setup.' :
                 'Your roof has some solar potential. Shading or orientation may limit output.';

    const ctaHeading = score >= 55 ? 'Your roof qualifies — here\'s what to do next' :
                       'Want to know for sure? Let\'s take a look';

    // Aerial image
    const aerialImageUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=19&size=640x300&maptype=satellite&key=${process.env.GOOGLE_API_KEY}`;

    // Claude summary
    let friendlyDesc = desc;
    try {
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
            content: `You are a friendly solar consultant for HmeWorx. Write ONE sentence (max 25 words) describing this home's solar potential. State: ${state}. Usable panel area: ${usableAreaM2}m², sun hours per day: ${sunHoursPerDay.toFixed(1)}, estimated annual production: ${annualProduction.toLocaleString()} kWh, panels: ${panels}, score: ${score}/100. Be encouraging and specific. Do not mention price or specific states unless relevant.`
          }]
        })
      });
      const claudeData = await claudeRes.json();
      if (claudeData.content?.[0]?.text) {
        friendlyDesc = claudeData.content[0].text;
      }
    } catch (claudeErr) {
      console.log('Claude error:', claudeErr.message);
    }

    res.json({
      score,
      title,
      desc: friendlyDesc,
      ctaHeading,
      roofArea: usableAreaM2,
      totalRoofArea,
      sunHours: parseFloat(sunHoursPerDay.toFixed(1)),
      annualProduction: annualProduction.toLocaleString(),
      systemSizeKw: parseFloat(systemSizeKw.toFixed(1)),
      panels,
      offset,
      state,
      aerialImageUrl,
      lat,
      lng
    });

  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/', (req, res) => res.send('Solar Checker API is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
