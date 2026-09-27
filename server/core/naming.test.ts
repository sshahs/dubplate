import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS } from "../settings"
import { renderTemplate, sanitizeFilename, tagsFor } from "./naming"

const naming = DEFAULT_SETTINGS.naming

describe("naming", () => {
  it("renders Artist - Title with version and featuring", () => {
    expect(renderTemplate("{artist} - {title}", { artists: ["Chronixx"], featuring: ["Protoje"], title: "Here Comes Trouble", version: "Dubplate" }, naming)).toBe(
      "Chronixx feat. Protoje - Here Comes Trouble (Dubplate)"
    )
  })

  it("joins clash artists with vs", () => {
    expect(renderTemplate("{artist} - {title}", { artists: ["Buju Banton", "Beenie Man"], featuring: [], relation: "vs", title: "Live Clash", year: 1993 }, naming)).toBe(
      "Buju Banton vs Beenie Man - Live Clash"
    )
  })

  it("lists three collaborators naturally", () => {
    expect(renderTemplate("{artist} - {title}", { artists: ["A", "B", "C"], featuring: [], relation: "&", title: "T" }, naming)).toBe("A, B & C - T")
  })

  it("drops empty template parts", () => {
    expect(renderTemplate("{year} - {artist} - {title} [{label}]", { artists: ["Kano"], featuring: [], title: "Ps and Qs" }, naming)).toBe("Kano - Ps and Qs")
    // Unknown tags are empty, including names of built-in object properties.
    expect(renderTemplate("{artist} - {title} [{constructor}]", { artists: ["Kano"], featuring: [], title: "Ps and Qs" }, naming)).toBe("Kano - Ps and Qs")
  })

  it("sanitises characters filesystems reject", () => {
    expect(sanitizeFilename('AC/DC: "Back" In <Black>?')).toBe("AC-DC - 'Back' In Black")
    expect(sanitizeFilename("con")).toBe("_con")
  })

  it("only fills album/year when the file has none", () => {
    const t = tagsFor({ artists: ["Kano"], featuring: [], title: "P's and Q's", album: "Home Sweet Home", year: 2005 }, { album: "Existing" }, naming)
    expect(t.album).toBeUndefined()
    expect(t.year).toBe(2005)
    expect(t.artist).toBe("Kano")
  })
})
