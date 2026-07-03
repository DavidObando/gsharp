// inventory: AttributeList — BCL attributes applied to a type and a member
// QUARANTINED sub-probes:
//   * a user-defined attribute class (`class NoteAttribute : Attribute`) translates
//     but gsc rejects the application with GS0200 "Type 'NoteAttribute' is not an
//     attribute class (it does not derive from System.Attribute)" — reproduced with
//     hand-written G# too, so it is a gsc limitation, not a translation bug;
//   * an attribute on a parameter ([Note] int seed) is SILENTLY dropped from the
//     emitted G# (no diagnostic; not observable via stdout without reflection).
using System;

namespace Corpus.Grid07
{
    [Obsolete("legacy type kept for the attribute fixture")]
    public class LegacyGadget
    {
        [Obsolete("use Renew instead")]
        public int OldWay(int seed)
        {
            return seed + 1;
        }

        public int Renew(int seed)
        {
            return seed + 2;
        }
    }

    public static class AttributeListFixture
    {
        public static void Run()
        {
            // CS0618 warnings are expected here; the corpus builds with warnings allowed.
            LegacyGadget gadget = new LegacyGadget();
            Console.WriteLine("AttributeList: old=" + gadget.OldWay(41).ToString());
            Console.WriteLine("AttributeList: renew=" + gadget.Renew(40).ToString());
        }
    }
}
