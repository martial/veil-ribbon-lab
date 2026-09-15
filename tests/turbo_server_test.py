"""Transport boundary tests; no model download or inference required."""
import base64
import io
import unittest
from fastapi import HTTPException
from PIL import Image
from scripts.turbo_server import decode_depth, Frame
from pydantic import ValidationError


def png(size, value=100):
    output = io.BytesIO()
    Image.new('RGB', size, (value, value, value)).save(output, 'PNG')
    return 'data:image/png;base64,' + base64.b64encode(output.getvalue()).decode()


class DepthInputTest(unittest.TestCase):
    def test_scalar_depth_is_preserved(self):
        image = decode_depth(png((384, 384), 137))
        self.assertEqual(image.size, (384, 384))
        self.assertEqual(image.getpixel((100, 100)), (137, 137, 137))

    def test_invalid_payload_and_oversized_images_are_rejected(self):
        for value in ['data:image/png;base64,invalid', 'https://example.com/depth.png', png((1024, 1024)), png((256, 384))]:
            with self.subTest(value=value[:50]):
                with self.assertRaises(HTTPException) as error:
                    decode_depth(value)
                self.assertEqual(error.exception.status_code, 400)

    def test_request_limits(self):
        valid = dict(frame_id=1, depth=png((256, 256)), prompt='Bronze relief')
        for extra in [dict(seed=-1), dict(strength=0), dict(prompt=''), dict(frame_id=-1)]:
            with self.subTest(extra=extra), self.assertRaises(ValidationError):
                Frame(**(valid | extra))


if __name__ == '__main__':
    unittest.main()
