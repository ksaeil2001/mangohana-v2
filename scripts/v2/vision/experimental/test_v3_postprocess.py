"""General current-image v3 postprocessing guards; no AI execution."""
import importlib.util
from pathlib import Path
import unittest
import cv2
import numpy as np


class V3PostprocessTests(unittest.TestCase):
    def module(self):
        path=Path(__file__).with_name("v3_postprocess.py")
        self.assertTrue(path.is_file(),"CURRENT_IMAGE_V3_KERNEL_MISSING")
        spec=importlib.util.spec_from_file_location("v3post",path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module

    def fixture(self):
        image=np.full((100,100,3),210,np.uint8)
        cv2.rectangle(image,(10,10),(90,90),(0,0,0),2)
        image[25:48,35:55]=255;image[30:42,40:48]=0
        mask=np.zeros((100,100),np.uint8);mask[34:38,:48]=255;mask[28:44,38:50]=255
        regions=[{"id":"dialogue-a","bbox":{"x":.2,"y":.2,"width":.6,"height":.6}}]
        return image,mask,regions

    def test_current_image_text_survives_a_learned_bridge_to_the_actual_frame(self):
        image,mask,regions=self.fixture()
        result,stats=self.module().refine(image,mask,regions)
        self.assertTrue((result[30:42,40:48]==255).all())
        self.assertFalse(result[10:13].any())
        self.assertEqual(stats["regions"][0]["id"],"dialogue-a")
        self.assertGreater(stats["regions"][0]["maskPixels"],0)
        self.assertEqual(stats["pixelsOutsideEnvelope"],0)
        self.assertEqual(stats["frameGuardPixelsMasked"],0)

    def test_refinement_preserves_input_arrays_and_returns_only_binary_mask(self):
        image,mask,regions=self.fixture();a=image.copy();b=mask.copy()
        result,_=self.module().refine(image,mask,regions)
        self.assertTrue(np.array_equal(image,a));self.assertTrue(np.array_equal(mask,b))
        self.assertTrue(np.isin(result,[0,255]).all())

    def test_empty_members_cannot_be_reported_as_complete(self):
        image=np.full((100,100,3),255,np.uint8);mask=np.zeros((100,100),np.uint8)
        with self.assertRaisesRegex(ValueError,"EMPTY|SEED"):
            self.module().refine(image,mask,[{"id":"empty","bbox":{"x":.2,"y":.2,"width":.4,"height":.4}}])

    def test_context_resource_budget_is_checked_before_image_operations(self):
        module=self.module()
        regions=[{"id":str(i),"bbox":{"x":0,"y":0,"width":1,"height":1}} for i in range(64)]
        with self.assertRaisesRegex(ValueError,"CONTEXT_BUDGET"):
            module.plan_regions(4000,3000,regions)


if __name__=="__main__":unittest.main()
