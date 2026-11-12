import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePublicOrigin } from "../env.ts";
import { createHarness } from "./harness.ts";

const canonical = "https://115.29.164.8";
const auth = { Authorization: "Bearer test-server-key-not-a-secret" };

describe("Node host canonical public origin", () => {
  it("pins the proxy trust boundary in both nginx vhosts", () => {
    for (const name of ["nginx-otto.conf", "nginx-otto-ip.conf"]) {
      const conf = readFileSync(new URL(`../../../../deploy/${name}`, import.meta.url), "utf8");
      const host = name === "nginx-otto.conf" ? "__OTTO_DOMAIN__" : "__OTTO_IP__";
      expect(conf).toContain(`proxy_set_header Host ${host};`);
      expect(conf).toContain("proxy_set_header X-Forwarded-For $remote_addr;");
      expect(conf).toContain('proxy_set_header CF-Connecting-IP "";');
      expect(conf).toMatch(/if \(\$http_host != __OTTO_(?:DOMAIN|IP)__\) \{ return 421; \}/);
    }
  });

  it("rejects insecure and malformed public addresses", () => {
    expect(parsePublicOrigin(canonical + "/")).toBe(canonical);
    expect(parsePublicOrigin("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    for (const value of ["http://ottocloud.cn", "https://ottocloud.cn/path", "https://user@ottocloud.cn", "https://ottocloud.cn?x=1"]) {
      expect(() => parsePublicOrigin(value)).toThrow();
    }
  });

  it("keeps anonymous and authenticated forged-host requests from poisoning login links or pairing commands", async () => {
    const harness = await createHarness();
    try {
      // Set the same binding main.ts validates before constructing the real steward.
      harness.env.OTTO_PUBLIC_ORIGIN = canonical;
      const anonymous = await harness.fetch("https://attacker.example/app");
      expect(anonymous.status).toBe(200); // login page: the Durable Object has seen the forged Host
      const link = await harness.fetch("https://attacker.example/api/login-link", { method: "POST", headers: auth });
      expect(link.status).toBe(200);
      expect((await link.json() as { url: string }).url).toMatch(/^https:\/\/115\.29\.164\.8\/link\//);
      const pairing = await harness.fetch("https://attacker.example/api/pairing", { method: "POST", headers: auth });
      expect(pairing.status).toBe(200);
      expect((await pairing.json() as { command: string }).command).toContain(`connect ${canonical} `);
      const stub = (harness.env.Steward as { idFromName(name: string): unknown; get(id: unknown): unknown });
      await harness.runInDurableObject(stub.get(stub.idFromName("owner")), (_instance, state) => {
        const rows = state.storage.sql.exec("SELECT origin FROM sh_deploy WHERE id = 1").toArray() as { origin: string }[];
        expect(rows[0]?.origin).toBe(canonical);
      });
    } finally {
      harness.dispose();
    }
  });
});
