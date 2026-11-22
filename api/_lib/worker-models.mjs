// A worker advertises the one model and recipe it can submit new customer shots to.
// Reconciling an old receipt does not make that model available for new orders.
export function heartbeatSupports(heartbeat, model, recipe) {
  return heartbeat?.ready === true && typeof model === 'string' && model.length > 0
    && typeof recipe === 'string' && recipe.length > 0 && heartbeat.model === model && heartbeat.recipe === recipe;
}
