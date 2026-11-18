import importlib.util
from pathlib import Path
import unittest


class RadialHaloTests(unittest.TestCase):
    def module(self):
        path=Path(__file__).with_name("radial_halo_candidate.py")
        self.assertTrue(path.is_file(),"RADIAL_HALO_NOT_IMPLEMENTED")
        spec=importlib.util.spec_from_file_location("radial",path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module

    def test_a_bounded_bright_outline_grows_through_its_antialias_edge(self):
        profile=[{"r":r,"whiteFraction":1 if 2<=r<=6 else .3,"medianGray":253 if 2<=r<=6 else 210} for r in range(1,15)]
        self.assertEqual(self.module().select_radius(profile,6,40),9)

    def test_an_unbounded_white_background_does_not_authorize_expansion(self):
        profile=[{"r":r,"whiteFraction":1,"medianGray":255} for r in range(1,20)]
        self.assertIsNone(self.module().select_radius(profile,6,40))

    def test_dark_unoutlined_ink_does_not_authorize_expansion(self):
        profile=[{"r":r,"whiteFraction":.1,"medianGray":170} for r in range(1,20)]
        self.assertIsNone(self.module().select_radius(profile,6,40))


if __name__=="__main__":unittest.main()
