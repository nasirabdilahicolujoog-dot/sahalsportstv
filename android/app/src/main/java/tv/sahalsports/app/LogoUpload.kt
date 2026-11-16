package tv.sahalsports.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

@Composable fun LogoUploadButton(vm: AppState, onUploaded: (String) -> Unit) {
    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) vm.perform {
            val encoded = withContext(Dispatchers.IO) {
                val bytes = ByteArray(2 * 1024 * 1024 + 1)
                val count = context.contentResolver.openInputStream(uri)?.use { input ->
                    var total = 0
                    while (total < bytes.size) {
                        val read = input.read(bytes, total, bytes.size - total)
                        if (read < 0) break
                        total += read
                    }
                    total
                } ?: throw IllegalArgumentException("The selected image could not be opened.")
                require(count < bytes.size) { "Choose an image smaller than 2 MB." }
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, count, bounds)
                require(bounds.outWidth in 1..8192 && bounds.outHeight in 1..8192) { "Choose a valid PNG, JPEG or WebP image." }
                val options = BitmapFactory.Options().apply {
                    inSampleSize = (maxOf(bounds.outWidth, bounds.outHeight) / 512).coerceAtLeast(1)
                }
                val bitmap = BitmapFactory.decodeByteArray(bytes, 0, count, options)
                    ?: throw IllegalArgumentException("The selected image could not be decoded.")
                val output = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
                bitmap.recycle()
                val png = output.toByteArray()
                require(png.size <= 2 * 1024 * 1024) { "The processed logo is too large. Choose a smaller image." }
                Base64.encodeToString(png, Base64.NO_WRAP)
            }
            val result = vm.api.call("POST", "/admin/logos", json("data" to encoded, "mimeType" to "image/png"))
            val url = result.text("url")
            require(url.isNotBlank()) { "The server did not return the uploaded logo address." }
            onUploaded(url)
            vm.message = "Logo uploaded. Save the channel to apply it."
        }
    }
    OutlinedButton(onClick = { picker.launch("image/*") }, enabled = !vm.busy) { Text("Upload channel logo") }
}
