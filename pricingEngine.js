// pricingEngine.js
// Usage-Based Insurance (UBI) Pricing Engine
// Calculates insurance premiums and safety scores based on driving statistics

const PRICING_CONFIG = {
  baseRatePerKm: 0.5,
  minTripPrice: 1.0,
  weights: {
    harshBraking: 2.0,
    harshAcceleration: 1.5,
    harshCornering: 1.8,
    speeding: 0.1,
    phoneUsage: 0.05, // per second
    nightDrivingMultiplier: 1.2, // 20% surcharge
    rushHourMultiplier: 1.1 // 10% surcharge
  }
};

/**
 * Calculate trip cost and safety score based on driving statistics
 * @param {Object} tripStats - Trip statistics object
 * @param {number} tripStats.distanceKm - Distance in kilometers
 * @param {number} tripStats.harshBrakingCount - Number of harsh braking events
 * @param {number} tripStats.harshAccelerationCount - Number of harsh acceleration events
 * @param {number} tripStats.harshCorneringCount - Number of harsh cornering events
 * @param {number} tripStats.phoneUsageSeconds - Phone usage duration in seconds
 * @param {number} tripStats.nightDrivingRatio - Ratio of night driving (0.0 to 1.0)
 * @param {number} tripStats.rushHourDrivingRatio - Ratio of rush hour driving (0.0 to 1.0)
 * @param {number} [tripStats.speedingEvents] - Number of speeding events (optional, defaults to 0)
 * @returns {Object} Pricing result with currency, basePrice, riskPenalty, finalPrice, and safetyScore
 */
function calculateTripCost(tripStats) {
  const {
    distanceKm = 0,
    harshBrakingCount = 0,
    harshAccelerationCount = 0,
    harshCorneringCount = 0,
    phoneUsageSeconds = 0,
    nightDrivingRatio = 0,
    rushHourDrivingRatio = 0,
    speedingEvents = 0
  } = tripStats;

  // Base price calculation
  const basePrice = distanceKm * PRICING_CONFIG.baseRatePerKm;

  // Risk penalty calculation
  const brakingPenalty = harshBrakingCount * PRICING_CONFIG.weights.harshBraking;
  const accelerationPenalty = harshAccelerationCount * PRICING_CONFIG.weights.harshAcceleration;
  const corneringPenalty = harshCorneringCount * PRICING_CONFIG.weights.harshCornering;
  const speedingPenalty = speedingEvents * PRICING_CONFIG.weights.speeding;
  const phonePenalty = phoneUsageSeconds * PRICING_CONFIG.weights.phoneUsage;

  const riskPenalty = brakingPenalty + accelerationPenalty + corneringPenalty + speedingPenalty + phonePenalty;

  // Context multiplier calculation
  // Formula: 1 + (nightRatio * (nightMultiplier - 1)) + (rushHourRatio * (rushHourMultiplier - 1))
  const nightMultiplierComponent = nightDrivingRatio * (PRICING_CONFIG.weights.nightDrivingMultiplier - 1);
  const rushHourMultiplierComponent = rushHourDrivingRatio * (PRICING_CONFIG.weights.rushHourMultiplier - 1);
  const contextMultiplier = 1 + nightMultiplierComponent + rushHourMultiplierComponent;

  // Final price calculation
  let finalPrice = (basePrice + riskPenalty) * contextMultiplier;

  // Ensure final price is not lower than minTripPrice (unless distance is 0)
  if (distanceKm > 0 && finalPrice < PRICING_CONFIG.minTripPrice) {
    finalPrice = PRICING_CONFIG.minTripPrice;
  }

  // Safety score calculation (0-100)
  // Start at 100, deduct points based on events per km
  let safetyScore = 100;

  if (distanceKm > 0) {
    const eventsPerKm = (harshBrakingCount + harshAccelerationCount + harshCorneringCount + speedingEvents) / distanceKm;
    const phoneUsagePerKm = phoneUsageSeconds / distanceKm;

    // Deduct points: more events per km = lower score
    // Using a scaling factor to ensure reasonable score distribution
    const eventDeduction = Math.min(eventsPerKm * 5, 50); // Cap at 50 points deduction
    const phoneDeduction = Math.min(phoneUsagePerKm * 0.1, 20); // Cap at 20 points deduction

    safetyScore = Math.max(0, 100 - eventDeduction - phoneDeduction);
    safetyScore = Math.round(safetyScore); // Round to integer
  }
  // If distance is 0, safety score remains 100

  return {
    currency: 'CNY',
    basePrice: Math.round(basePrice * 100) / 100, // Round to 2 decimal places
    riskPenalty: Math.round(riskPenalty * 100) / 100,
    finalPrice: Math.round(finalPrice * 100) / 100,
    safetyScore
  };
}

module.exports = {
  calculateTripCost,
  PRICING_CONFIG
};

