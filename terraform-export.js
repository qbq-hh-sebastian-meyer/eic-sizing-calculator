(function (root) {
  "use strict";
  const A = typeof module !== "undefined" && module.exports ? require("./azure-sizing.js") : root.AzureSizing;
  const SOURCE = {
    repository: "Azure/sap-edge-integration-cell-on-azure-accelerator",
    commit: "cc90ea65cdcd3cff4006ef0611f1bb2ba1a95a7e",
    path: "production-ready/azure-paas/variables.tf"
  };
  SOURCE.url = `https://github.com/${SOURCE.repository}/blob/${SOURCE.commit}/${SOURCE.path}`;
  const LICENSE = `MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
  // Names, types and validations follow the pinned PaaS module; unknown sizes/zones stay required.
  const VARIABLES = [
    { name: "resource_group_name", type: "string", description: "Resource group name; supply your environment value." },
    { name: "location", type: "string", description: "Planning region from the Azure mapping; availability not verified." },
    { name: "tags", type: "map(string)", default: {}, description: "Resource tags." },
    { name: "create_private_dns_zones", type: "bool", default: true, description: "Create and link private DNS zones; supply vnet_id." },
    { name: "vnet_id", type: "string", default: null, description: "Virtual network resource ID; required when creating private DNS zones." },
    { name: "existing_postgres_private_dns_zone_id", type: "string", default: null, description: "PostgreSQL private DNS zone ID when reusing existing DNS." },
    { name: "existing_redis_private_dns_zone_id", type: "string", default: null, description: "Redis private DNS zone ID when reusing existing DNS." },
    { name: "postgres_server_name", type: "string", description: "PostgreSQL server name; supply your environment value." },
    { name: "postgres_database_name", type: "string", default: "eic", description: "EIC PostgreSQL database name." },
    { name: "postgres_admin_username", type: "string", default: "pgadmin", description: "PostgreSQL administrator username; not a password." },
    { name: "postgres_sku_name", type: "string", description: "Required: size PostgreSQL independently; no SKU is inferred from AKS." },
    { name: "postgres_storage_mb", type: "number", description: "Required: PostgreSQL storage in MB, based on throughput and retention." },
    { name: "postgres_backup_retention_days", type: "number", default: 14, description: "Upstream example retention; review against your recovery requirements.", validation: [
      "var.postgres_backup_retention_days >= 7 && var.postgres_backup_retention_days <= 35",
      "postgres_backup_retention_days must be between 7 and 35."
    ] },
    { name: "postgres_geo_redundant_backup_enabled", type: "bool", default: false, description: "Upstream backup default; review disaster recovery requirements." },
    { name: "postgres_version", type: "string", default: "15", description: "PostgreSQL version from SAP Note 3247839 v96; overrides the upstream version 16 default." },
    { name: "postgres_zone", type: "string", description: "Required: choose a primary zone supported by the selected region and SKU." },
    { name: "postgres_standby_zone", type: "string", description: "Required: choose a distinct supported standby zone for zone-redundant HA." },
    { name: "postgres_ha_enabled", type: "bool", description: "HA intent from the mapping; validate PaaS zone redundancy separately." },
    { name: "postgres_delegated_subnet_id", type: "string", description: "PostgreSQL delegated subnet resource ID; supply your network design." },
    { name: "redis_name", type: "string", description: "Cache resource name; the pinned module uses Azure Cache for Redis, not Azure Managed Redis." },
    { name: "redis_sku_name", type: "string", description: "Required: independently select a legacy Cache for Redis SKU accepted by this module.", validation: [
      'contains(["Basic", "Standard", "Premium"], var.redis_sku_name)',
      "redis_sku_name must be one of: Basic, Standard, Premium."
    ] },
    { name: "redis_family", type: "string", description: "Required: cache family matching the independently selected legacy SKU." },
    { name: "redis_capacity", type: "number", description: "Required: cache capacity based on working set, artifacts and policy counts." },
    { name: "redis_minimum_tls_version", type: "string", default: "1.2", description: "Minimum cache TLS version." },
    { name: "redis_private_endpoint_subnet_id", type: "string", description: "Cache private endpoint subnet resource ID." },
    { name: "redis_zones", type: "list(string)", description: "Required: explicitly choose supported cache zones, or an empty list if appropriate." },
    { name: "store_secrets_in_key_vault", type: "bool", default: false, description: "Upstream secret-storage default; review and supply key_vault_id when enabled." },
    { name: "key_vault_id", type: "string", default: null, description: "Key Vault resource ID when storing generated credentials." }
  ];
  const comments = text => text.split("\n").map(line => `# ${line}`.trimEnd()).join("\n");
  function generate(workbook, scenario, inputs) {
    const validInputs = A.validateInputs(inputs);
    const mapping = A.compute(workbook, scenario, validInputs);
    if (mapping.status !== "preliminary") throw new Error(`Resolve the blocked Azure mapping before exporting: ${mapping.errors.join(" ")}`);
    const overrides = { location: mapping.scenario.region, postgres_ha_enabled: mapping.scenario.mode === "ha" };
    const variables = VARIABLES.map(v => ({ ...v, ...(Object.hasOwn(overrides, v.name) ? { default: overrides[v.name] } : {}) }));
    const required = variables.filter(v => !Object.hasOwn(v, "default")).map(v => v.name);
    const warnings = [
      "This PaaS module has no AKS node, maxPods, Solace, PVC or replica variables. The full current Azure mapping is included as reference comments only; it does not provision those resources.",
      "The pinned module main.tf uses azurerm_redis_cache (Azure Cache for Redis), NOT Azure Managed Redis. The mapping prefers Managed Redis. Variables alone cannot resolve this resource mismatch; review or adapt the accelerator before applying.",
      `Mapped defaults: location = ${mapping.scenario.region}, postgres_version = 15 (SAP source snapshot, replacing upstream 16), postgres_ha_enabled = ${overrides.postgres_ha_enabled}. HA here expresses intent, not verified regional PaaS availability.`,
      "Database/cache SKU, capacity, storage and zone values are intentionally required, not fabricated from worker sizing. Supply resource names, subnet IDs and the conditional DNS/Key Vault IDs as well.",
      "Other retained defaults are upstream examples, not calculator sizing recommendations. Review backup, secret storage, networking and regional support before deployment.",
      "Replace variables.tf in the accelerator's production-ready/azure-paas directory; this is a variable declaration file, NOT terraform.tfvars. Existing .tfvars files, TF_VAR_* environment variables and CLI arguments override its defaults.",
      "Export only: no Azure deployment is performed. The preliminary capacity estimate does not establish SAP validation, actual scheduling or failure recovery."
    ];
    const blocks = variables.map(v => {
      const lines = [
        `variable "${v.name}" {`,
        `  description = ${JSON.stringify(v.description)}`,
        `  type        = ${v.type}`
      ];
      if (Object.hasOwn(v, "default")) lines.push(`  default     = ${JSON.stringify(v.default)}`);
      if (v.validation) lines.push("", "  validation {", `    condition     = ${v.validation[0]}`, `    error_message = ${JSON.stringify(v.validation[1])}`, "  }");
      lines.push("}");
      return lines.join("\n");
    }).join("\n\n");
    const header = [
      "EIC Azure Mapping - variables.tf (PaaS compatibility export)",
      `Adapted from: ${SOURCE.url}`,
      `Pinned upstream commit: ${SOURCE.commit}`,
      ...warnings,
      `Required variables (no default): ${required.join(", ")}`
    ].join("\n");
    const appendix = [
      "Current Azure mapping snapshot - REFERENCE ONLY, NOT Terraform resource settings:",
      JSON.stringify({ sources: A.SOURCES, azure: mapping }, null, 2),
      "",
      "Upstream license notice:",
      LICENSE
    ].join("\n");
    return { filename: "variables.tf", content: `${comments(header)}\n\n${blocks}\n\n${comments(appendix)}\n`, warnings, required, source: SOURCE };
  }
  const api = { SOURCE, generate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TerraformExport = api;
})(globalThis);
