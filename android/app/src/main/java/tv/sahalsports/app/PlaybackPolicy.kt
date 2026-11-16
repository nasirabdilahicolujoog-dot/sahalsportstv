package tv.sahalsports.app

import java.net.URI

fun isTrustedPlaybackUrl(url: String, apiBaseUrl: String): Boolean = runCatching {
    val stream = URI(url)
    val backend = URI(apiBaseUrl)
    stream.scheme in listOf("https", "http") && stream.scheme == backend.scheme &&
        stream.host != null && stream.host.equals(backend.host, ignoreCase = true) &&
        stream.port == backend.port && stream.userInfo == null && stream.fragment == null
}.getOrDefault(false)
