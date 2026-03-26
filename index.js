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
 
    // Step 2: Get solar data
    const solarRes = await fetch(
      `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&requiredQuality=LOW&key=${process.env.GOOGLE_API_KEY}`
    );
    const solarData = await solarRes.json();console.log('RAW SOLAR:', JSON.stringify(solarData.solarPotential).substring(0, 2000));
 
    if (solarData.error) {
      return res.status(404).json({ error: 'Solar data not found for this address' });
    }
 
    const solar = solarData.solarPotential;
 
    // Safely extract roof area
    const roofArea = Math.round(
      solar.wholeRoofStats?.areaMeters2 ||
      solar.maxArrayAreaMeters2 ||
      0
    );
 
    // Safely extract sun hours
    const maxSunshine = solar.maxSunshineHoursPerYear || solar.panelCapacityWatts || 0;
    const sunHours = maxSunshine > 8760 ? (maxSunshine / 365) : (maxSunshine > 24 ? maxSunshine / 365 : maxSunshine);
 
    // Safely extract panel count
    const panels = solar.solarPanels?.length ||
      solar.maxArrayPanelsCount ||
      Math.floor(roofArea / 2.6) ||
      0;
 
    // Safely extract annual production
    const annualProduction = Math.round(
      solar.maxArrayAnnualEnergyKwh ||
      solar.wholeRoofStats?.sunshineQuantiles?.[5] ||
      (sunHours * 365 * roofArea * 0.15) ||
      0
    );
 
    // Offset as percentage of typical VA home (10,500 kWh/year)
    const offset = annualProduction > 0 ? Math.min(Math.round((annualProduction / 10500) * 100), 100) : 0;
 
    // Score the property
    const sunScore = sunHours > 4.5 ? 30 : sunHours > 4 ? 20 : 10;
    const areaScore = roofArea > 60 ? 35 : roofArea > 40 ? 25 : 15;
    const productionScore = annualProduction > 10000 ? 35 : annualProduction > 7000 ? 25 : 15;
    const score = sunScore + areaScore + productionScore;
 
    const title = score >= 85 ? 'Excellent solar candidate' :
                  score >= 70 ? 'Strong solar candidate' :
                  score >= 55 ? 'Good solar candidate' : 'Moderate solar potential';
 
    const desc = score >= 85 ? 'Your roof has strong solar exposure with ample usable area for a full system.' :
                 score >= 70 ? 'Your roof is a solid candidate for solar with good production potential.' :
                 score >= 55 ? 'Your roof has good solar potential. An assessment will confirm the best setup.' :
                 'Your roof has some solar potential. Shading or orientation may limit output.';
 
    const ctaHeading = score >= 55 ? 'Your roof qualifies — here\'s what to do next' :
                       'Want to know for sure? Let\'s take a look';
 
    // Step 3: Get aerial image URL
    const aerialImageUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=19&size=640x300&maptype=satellite&key=${process.env.GOOGLE_API_KEY}`;
 
    // Step 4: Ask Claude for a friendly summary
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
            content: `You are a friendly solar consultant. Write ONE sentence (max 25 words) describing this home's solar potential. Roof area: ${roofArea}m², sun hours per day: ${sunHours.toFixed(1)}, annual production estimate: ${annualProduction} kWh, score: ${score}/100. Be encouraging and specific.`
          }]
        })
      });
      const claudeData = await claudeRes.json();
      if (claudeData.content?.[0]?.text) {
        friendlyDesc = claudeData.content[0].text;
      }
    } catch (claudeErr) {
      console.log('Claude error, using default desc:', claudeErr.message);
    }
 
    res.json({
      score,
      title,
      desc: friendlyDesc,
      ctaHeading,
      roofArea,
      sunHours: parseFloat(sunHours.toFixed(1)),
      annualProduction: annualProduction.toLocaleString(),
      panels,
      offset,
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
