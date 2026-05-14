export function buildDiscoverPool({ profiles, industry = 'all', reported = [], matches = [], passed = [] }) {
  return profiles.filter((p) => {
    const industryOk = industry === 'all' ? true : (p.tags || []).includes(industry);
    const notReported = !reported.includes(String(p.id));
    const notMatched = !matches.find((m) => String(m.id) === String(p.id));
    const notPassed = !passed.includes(String(p.id));
    return industryOk && notReported && notMatched && notPassed;
  });
}
