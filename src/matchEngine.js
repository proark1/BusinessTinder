export function decideMatch(direction, candidateRightSwipesYou) {
  if (direction !== "right" && direction !== "left") {
    throw new Error("Invalid direction");
  }
  return direction === "right" && candidateRightSwipesYou === true;
}

export function profileCompletionPercent(profile) {
  if (!profile) return 0;
  const fields = ["name", "role", "bio", "interests", "goal", "location"];
  const done = fields.filter((f) => String(profile[f] || "").trim().length > 0).length;
  return Math.round((done / fields.length) * 100);
}
