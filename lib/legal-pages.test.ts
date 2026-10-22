import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import PrivacyPage from "@/app/privacy/page";
import TermsPage from "@/app/terms/page";

afterEach(() => vi.unstubAllEnvs());

describe("Twilio Comics legal pages", () => {
  it("uses the supplied operator and support contact by default", () => {
    vi.stubEnv("APP_OPERATOR_NAME", undefined);
    vi.stubEnv("APP_CONTACT_EMAIL", undefined);

    const privacy = renderToStaticMarkup(PrivacyPage());
    const terms = renderToStaticMarkup(TermsPage());

    expect(privacy).toContain("Anthony Dellavecchia");
    expect(terms).toContain("Anthony Dellavecchia");
    expect(privacy).toContain('href="mailto:adellavecchia@twilio.com"');
    expect(terms).toContain('href="mailto:adellavecchia@twilio.com"');
    expect(privacy).not.toMatch(/draft|not (?:yet )?published/i);
  });

  it("labels policies as drafts when the app operator and contact are not configured", () => {
    vi.stubEnv("APP_OPERATOR_NAME", "");
    vi.stubEnv("APP_CONTACT_EMAIL", "");

    const privacy = renderToStaticMarkup(PrivacyPage());
    const terms = renderToStaticMarkup(TermsPage());

    expect(privacy).toMatch(/draft|not (?:yet )?published/i);
    expect(terms).toMatch(/draft|not (?:yet )?published/i);
    expect(privacy).toContain("Twilio provider privacy notice");
    expect(terms).toContain("Twilio provider terms");
    expect(privacy).not.toContain("mailto:");
    expect(terms).not.toContain("mailto:");
  });

  it("identifies the app operator and contact and distinguishes Twilio's provider policies", () => {
    vi.stubEnv("APP_OPERATOR_NAME", "Example Operator LLC");
    vi.stubEnv("APP_CONTACT_EMAIL", "support@example.test");

    const privacy = renderToStaticMarkup(PrivacyPage());
    const terms = renderToStaticMarkup(TermsPage());

    expect(privacy).toContain("Example Operator LLC");
    expect(terms).toContain("Example Operator LLC");
    expect(privacy).toContain('href="mailto:support@example.test"');
    expect(terms).toContain('href="mailto:support@example.test"');
    expect(privacy).not.toMatch(/draft|not (?:yet )?published/i);
    expect(terms).not.toMatch(/draft|not (?:yet )?published/i);
    expect(privacy).toMatch(/until we explicitly delete them/i);
    expect(privacy).toMatch(/no automatic expiration schedule/i);
    expect(privacy).toMatch(/not.*share.*mobile.*(?:marketing|promotional)/i);
    expect(terms).toMatch(/Message frequency varies/i);
    expect(terms).toMatch(/STOP.*opt out/i);
    expect(privacy).toContain('href="https://www.twilio.com/en-us/legal/privacy"');
    expect(terms).toContain('href="https://www.twilio.com/en-us/legal/tos"');
  });
});
