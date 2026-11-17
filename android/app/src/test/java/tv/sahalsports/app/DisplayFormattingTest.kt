package tv.sahalsports.app

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class DisplayFormattingTest {
    @Test fun expiredTrialNeverShowsNegativeTime() {
        assertEquals(0L, secondsRemaining(Instant.now().minusSeconds(60).toString()))
    }
    @Test fun missingTrialDoesNotGrantTime() {
        assertEquals(0L, secondsRemaining(""))
        assertEquals(0L, secondsRemaining("invalid"))
    }
    @Test fun activeTrialShowsRemainingSeconds() {
        assertTrue(secondsRemaining(Instant.now().plusSeconds(60).toString()) in 58..60)
    }
    @Test fun missingDateHasHonestFallback() {
        assertEquals("Not available", formatDate(""))
    }
    @Test fun dateFormattingUsesReadableYear() {
        assertTrue(formatDate("2026-11-15T12:00:00Z").contains("2026"))
    }
    @Test fun priceMinorUnitsKeepTwoDecimals() {
        assertEquals("0.50", formatMinor(50))
        assertEquals("0.01", formatMinor(1))
        assertEquals("50.00", formatMinor(5000))
        assertEquals("0.00", formatMinor(0))
    }
}
