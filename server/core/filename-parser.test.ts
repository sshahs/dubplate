import { describe, expect, it } from "vitest"
import { parseFilename } from "./filename-parser"
import { normArtist } from "./normalize"

const known = new Set(["buju banton", "beenie man", "sly and robbie", "skepta", "jme", "wiley"].map(normArtist))

describe("parseFilename", () => {
  it("untangles an underscored clash dubplate", () => {
    const p = parseFilename("12_buju_banton_vs_beenie_man_live_93_dubplate.mp3", { knownArtists: known })
    expect(p.trackNumber).toBe("12")
    expect(p.artists).toEqual(["Buju Banton", "Beenie Man"])
    expect(p.relation).toBe("vs")
    expect(p.year).toBe(1993)
    expect(p.hints).toEqual(expect.arrayContaining(["dubplate", "live"]))
    expect(p.version).toBe("Dubplate")
  })

  it("handles the clash without a known-artist list", () => {
    const p = parseFilename("12_buju_banton_vs_beenie_man_live_93_dubplate.mp3")
    expect(p.artists).toEqual(["Buju Banton", "Beenie Man"])
    expect(p.year).toBe(1993)
  })

  it("parses a clean Artist - Title", () => {
    const p = parseFilename("Skepta - Shutdown.mp3")
    expect(p.artists).toEqual(["Skepta"])
    expect(p.title).toBe("Shutdown")
    expect(p.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it("strips track numbers, rip-site junk and quality markers", () => {
    const p = parseFilename("03. Wiley - Wot Do U Call It (Official Video) [320kbps] www.grimeripz.com.mp3")
    expect(p.trackNumber).toBe("03")
    expect(p.artists).toEqual(["Wiley"])
    expect(p.title).toBe("Wot Do U Call It")
  })

  it("keeps mixed-case names and splits featuring", () => {
    const p = parseFilename("Chronixx feat. Protoje - Here Comes Trouble (Dubplate).flac")
    expect(p.artists).toEqual(["Chronixx"])
    expect(p.featuring).toEqual(["Protoje"])
    expect(p.title).toBe("Here Comes Trouble")
    expect(p.version).toBe("Dubplate")
  })

  it("does not split known duos containing &", () => {
    const p = parseFilename("sly & robbie - boops.mp3", { knownArtists: known })
    expect(p.artists).toEqual(["Sly & Robbie"])
  })

  it("keeps years that are part of a title", () => {
    const p = parseFilename("Prince - 1999 (Remastered).mp3")
    expect(p.title).toContain("1999")
  })

  it("does not eat numeric artist names", () => {
    const p = parseFilename("50 Cent - In Da Club.mp3")
    expect(p.artists).toEqual(["50 Cent"])
  })

  it("handles Title by Artist", () => {
    const p = parseFilename("Murder She Wrote by Chaka Demus & Pliers.mp3")
    expect(p.title).toBe("Murder She Wrote")
    expect(p.artists).toEqual(["Chaka Demus", "Pliers"])
  })

  it("flags generic names", () => {
    const p = parseFilename("Track 07.mp3")
    expect(p.confidence).toBeLessThanOrEqual(0.25)
  })

  it("handles vinyl side markers and hyphen-only names", () => {
    const p = parseFilename("A1-Tenor_Saw-Ring_The_Alarm.mp3")
    expect(p.trackNumber).toBe("A1")
    expect(p.artists).toEqual(["Tenor Saw"])
    expect(p.title).toBe("Ring The Alarm")
  })

  it("reads clash tapes named the way soundtape.com and SoundCloud uploads name them", () => {
    // The year closing the clash isn't part of the second sound's name.
    expect(parseFilename("KILLAMANJARO VS STONE LOVE 1994 - FEAT. JOSIE WALES, HUGH BROWN & RICKY TROOPER.mp3")).toMatchObject({
      artists: ["Killamanjaro", "Stone Love"],
      relation: "vs",
      year: 1994,
      featuring: ["Josie Wales", "Hugh Brown", "Ricky Trooper"],
    })
    // A bracket after the sounds describes the tape; it used to make "Bodyguard Classic" and a title of "Dubplates)".
    expect(parseFilename("Stone Love vs Bodyguard (Classic Dubplates).mp3")).toMatchObject({ artists: ["Stone Love", "Bodyguard"], title: "", version: "Classic Dubplates" })
    // Three sounds, and a date after them.
    expect(parseFilename("Killamanjaro vs Stone Love vs Metro Media 9-94 (Portland).mp3")).toMatchObject({ artists: ["Killamanjaro", "Stone Love", "Metro Media"], relation: "vs" })
    // A year in a name that isn't a clash stays put.
    expect(parseFilename("Prince 1999 - Little Red Corvette.mp3").artists).toEqual(["Prince 1999"])
  })

  it("uses the embedded tag artist when there is no separator", () => {
    const p = parseFilename("champion lover.mp3", { tagArtist: "Deborahe Glasgow" })
    expect(p.artists).toEqual(["Deborahe Glasgow"])
  })
})