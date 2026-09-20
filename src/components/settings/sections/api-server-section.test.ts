import { describe, expect, it } from "vitest"

import { API_ENDPOINTS, buildSourceCurlExamples } from "./api-server-section"

describe("API server endpoint documentation", () => {
  it("lists the project review endpoint", () => {
    expect(API_ENDPOINTS).toContainEqual({
      method: "GET",
      path: "/api/v1/projects/{id}/reviews",
      noteKey: "endpointReviewsNote",
    })
  })

  it("lists Source API create/update and delete endpoints", () => {
    expect(API_ENDPOINTS).toContainEqual({
      method: "PUT",
      path: "/api/v1/projects/{id}/sources/file",
      noteKey: "endpointSourcePutNote",
    })
    expect(API_ENDPOINTS).toContainEqual({
      method: "DELETE",
      path: "/api/v1/projects/{id}/sources/file",
      noteKey: "endpointSourceDeleteNote",
    })
  })

  it("builds paste-ready Source API curl examples against the active project", () => {
    const examples = buildSourceCurlExamples("test-token")

    expect(examples.put).toContain("curl -X PUT")
    expect(examples.put).toContain("Authorization: Bearer test-token")
    expect(examples.put).toContain("/api/v1/projects/current/sources/file")
    expect(examples.put).toContain('"path":"source-demo.md"')
    expect(examples.put).toContain('"content":"# Source demo')

    expect(examples.delete).toContain("curl -X DELETE")
    expect(examples.delete).toContain("Authorization: Bearer test-token")
    expect(examples.delete).toContain(
      "/api/v1/projects/current/sources/file?path=source-demo.md",
    )
  })
})
