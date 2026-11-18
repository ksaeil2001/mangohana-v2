"""Physical source-frame regression, independent of any manga ID or model."""
import importlib.util
from pathlib import Path
import unittest
import cv2
import numpy as np

spec=importlib.util.spec_from_file_location("components",Path(__file__).with_name("refine_source_components.py"))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class SourceComponentTests(unittest.TestCase):
    def test_a_learned_bridge_to_a_frame_does_not_remove_the_separate_source_glyph(self):
        source=np.full((100,100,3),210,np.uint8)
        cv2.rectangle(source,(10,10),(90,90),(0,0,0),2)
        source[25:48,35:55]=255
        source[30:42,40:48]=0
        baseline=np.zeros((100,100),np.uint8)
        baseline[34:38,:48]=255
        baseline[28:44,38:50]=255
        result,frame,stats=module.refine_region(source,baseline,(5,5,95,95),(0,0,100,100),[])
        self.assertTrue((result[30:42,40:48]==255).all())
        self.assertEqual(int(np.count_nonzero((result>0)&(frame>0))),0)
        self.assertLess(np.count_nonzero(result),1000)

    def test_a_nearby_small_ink_dot_is_recovered_without_selecting_a_distant_dot(self):
        source=np.full((100,100,3),210,np.uint8)
        source[20:40,40:48]=0
        source[45:48,42:45]=0
        source[80:83,42:45]=0
        baseline=np.zeros((100,100),np.uint8);baseline[18:42,38:50]=255
        result,frame,stats=module.refine_region(source,baseline,(20,10,80,95),(0,0,100,100),[])
        self.assertTrue((result[45:48,42:45]==255).all())
        self.assertFalse(result[80:83,42:45].any())
        self.assertEqual(len(stats["addedSmallComponents"]),1)


if __name__=="__main__":unittest.main()
