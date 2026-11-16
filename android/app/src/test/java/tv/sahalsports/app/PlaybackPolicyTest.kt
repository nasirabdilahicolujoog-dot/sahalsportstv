package tv.sahalsports.app

import org.junit.Assert.*
import org.junit.Test

class PlaybackPolicyTest {
    private val backend = "https://api.example.test/v1"
    @Test fun acceptsProtectedBackendStream() {
        assertTrue(isTrustedPlaybackUrl("https://api.example.test/v1/streams/channel/index.m3u8", backend))
    }
    @Test fun rejectsCredentialsBeingSentToAnotherOrigin() {
        assertFalse(isTrustedPlaybackUrl("https://attacker.example.test/channel.m3u8", backend))
        assertFalse(isTrustedPlaybackUrl("https://api.example.test.attacker.test/channel.m3u8", backend))
    }
    @Test fun rejectsDowngradeAndEmbeddedCredentials() {
        assertFalse(isTrustedPlaybackUrl("http://api.example.test/stream", backend))
        assertFalse(isTrustedPlaybackUrl("https://user:password@api.example.test/stream", backend))
    }
    @Test fun rejectsLocalAndMalformedUris() {
        assertFalse(isTrustedPlaybackUrl("file:///private/stream", backend))
        assertFalse(isTrustedPlaybackUrl("not a URL", backend))
        assertFalse(isTrustedPlaybackUrl("/v1/stream", backend))
    }
    @Test fun rejectsDifferentPort() {
        assertFalse(isTrustedPlaybackUrl("https://api.example.test:8443/stream", backend))
    }
}
