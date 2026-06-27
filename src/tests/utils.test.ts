import { describe, it, expect } from "vitest";
import { shortenAddress, validatePaymentInput } from "../lib/stellar";
import { stroopsToXlm, xlmToStroopsArg, addressArg } from "../lib/contractArgs";
import * as StellarSdk from "@stellar/stellar-sdk";

describe("Frontend SDK Utility Tests", () => {
  describe("shortenAddress", () => {
    it("should shorten public keys correctly", () => {
      const address = "GDRM7Y5MDHEVHV3YPVPGYXSQI5KCCAN4UBMNMJAUUDYIBHGDF6WMNZV3";
      expect(shortenAddress(address)).toBe("GDRM7...MNZV3");
      expect(shortenAddress(address, 4, 4)).toBe("GDRM...NZV3");
    });

    it("should return empty string for empty input", () => {
      expect(shortenAddress("")).toBe("");
    });
  });

  describe("contractArgs utilities", () => {
    it("should convert stroops to XLM display string", () => {
      expect(stroopsToXlm(10000000n)).toBe("1.0000000");
      expect(stroopsToXlm(15200000000n)).toBe("1520.0000000");
      expect(stroopsToXlm(500000n)).toBe("0.0500000");
    });

    it("should create ScVal address correctly", () => {
      const address = "GDRM7Y5MDHEVHV3YPVPGYXSQI5KCCAN4UBMNMJAUUDYIBHGDF6WMNZV3";
      const scVal = addressArg(address);
      expect(scVal.switch()).toBe(StellarSdk.xdr.ScValType.scvAddress());
    });

    it("should convert XLM string to stroops ScVal", () => {
      const scVal = xlmToStroopsArg("10.5");
      expect(scVal.switch()).toBe(StellarSdk.xdr.ScValType.scvI128());
    });
  });

  describe("validatePaymentInput", () => {
    it("should validate valid public keys and positive amounts", () => {
      const address = "GDRM7Y5MDHEVHV3YPVPGYXSQI5KCCAN4UBMNMJAUUDYIBHGDF6WMNZV3";
      expect(() => validatePaymentInput(address, "100")).not.toThrow();
    });

    it("should throw error for invalid public keys", () => {
      expect(() => validatePaymentInput("invalidkey", "10")).toThrow(
        "Enter a valid Stellar public key that starts with G."
      );
    });

    it("should throw error for invalid or negative amounts", () => {
      const address = "GDRM7Y5MDHEVHV3YPVPGYXSQI5KCCAN4UBMNMJAUUDYIBHGDF6WMNZV3";
      expect(() => validatePaymentInput(address, "-10")).toThrow(
        "Enter an XLM amount greater than 0."
      );
      expect(() => validatePaymentInput(address, "0")).toThrow(
        "Enter an XLM amount greater than 0."
      );
    });
  });
});
