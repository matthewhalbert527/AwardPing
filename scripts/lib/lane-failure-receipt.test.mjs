import { describe, expect, it } from "vitest";
import {
  formatLaneFailureReceipt,
  parseLaneFailureReceipt,
} from "./lane-failure-receipt.mjs";

const receipt = {
  lane_key: "manual_quarantine",
  failure_code: "database_statement_timeout",
  retry_automatic: true,
  creates_api_charge: false,
};

describe("lane failure receipts", () => {
  it("round-trips a bounded secret-free receipt from a mixed stderr tail", () => {
    const output = `ordinary error\n${formatLaneFailureReceipt(receipt)}\nmore output`;
    expect(parseLaneFailureReceipt(output)).toMatchObject(receipt);
  });

  it("ignores malformed and unsupported markers", () => {
    expect(parseLaneFailureReceipt("AWARDPING_LANE_FAILURE not-json")).toBeNull();
    expect(parseLaneFailureReceipt(
      'AWARDPING_LANE_FAILURE {"schema_version":"future"}',
    )).toBeNull();
  });

  it("rejects unsafe or unknown machine codes", () => {
    expect(() => formatLaneFailureReceipt({ ...receipt, failure_code: "bad code" })).toThrow(
      /machine code/i,
    );
    expect(() => formatLaneFailureReceipt({
      ...receipt,
      failure_code: "unreviewed_future_failure",
    })).toThrow(/allowlisted failure contract/i);
  });

  it("never serializes free text or secret-shaped producer input", () => {
    const output = formatLaneFailureReceipt({
      ...receipt,
      failure_message: "Bearer sb_secret_should_never_be_persisted",
      recommended_action: "https://user:password@example.test/",
    });
    expect(output).not.toContain("Bearer");
    expect(output).not.toContain("sb_secret_");
    expect(output).not.toContain("password");
    expect(parseLaneFailureReceipt(output)).toEqual(expect.objectContaining(receipt));
  });
});
