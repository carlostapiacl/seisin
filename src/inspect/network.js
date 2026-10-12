export function modelEndpointWarnings(config, roles) {
  const warnings = [];
  /**
   * A role that can write code and cannot reach any inference API.
   *
   * Reported three separate times, by three different people, with the same
   * shape each time: a list of what agents need, written somewhere that does
   * not know which agent will run. The last instance cost six bench runs that
   * finished in eight seconds with `403 Connection blocked by network
   * allowlist` — which in a results table reads as "this model cannot do the
   * task", not as a policy error.
   *
   * What is deliberately NOT here: a registry of agents and their endpoints.
   * That is the same defect in a new place, and the reporter said so before I
   * could. The list below is only ever consulted to decide whether to print a
   * sentence, so being wrong about it costs a false warning — never a broken
   * run. That asymmetry is the whole reason it is allowed to exist, and the
   * warning says out loud that the list is ours and may not know your agent.
   */
  const INFERENCE = /(anthropic|openai|googleapis|generativelanguage|bedrock|azure|openrouter|mistral|groq|together|deepseek|x\.ai|cohere|ollama|localhost|127\.0\.0\.1)/i;
  for (const r of roles) {
    const domains = r.network ?? config.allowedDomains ?? [];
    if (domains.some((d) => INFERENCE.test(d))) continue;
    warnings.push({
      kind: "no-model-endpoint",
      headline: domains.length
        ? `${r.name} has ${domains.length} allowed domain(s) and none looks like a model API`
        : `${r.name} may reach no network at all`,
      detail:
        "an agent that cannot reach its own model fails at startup with a 403 from the " +
        "egress proxy, which reads as a broken install or a bad model rather than a policy. " +
        "This check knows a handful of providers and will not know yours — it is a question, " +
        "not a verdict.",
    });
  }
  return warnings;
}
