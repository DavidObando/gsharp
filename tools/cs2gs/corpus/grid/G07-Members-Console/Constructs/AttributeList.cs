// inventory: AttributeList — BCL attributes applied to a type and a member,
// plus (issue #1921, fixed) a user-defined attribute class applied to a type.
// QUARANTINED sub-probes:
//   * an attribute on a parameter ([Note] int seed) is SILENTLY dropped from the
//     emitted G# (no diagnostic; not observable via stdout without reflection).
using System;
using System.Linq;
using System.Reflection;

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

    // Issue #1921: user-defined attribute class — a plain `: Attribute` base
    // clause (translated verbatim, no `@Attribute` sugar needed) used to be
    // rejected by gsc with GS0200 "Type 'NoteAttribute' is not an attribute
    // class". Both the declaration and the application are exercised below;
    // the applied instance and its constructor argument are read back via
    // reflection since custom-attribute application isn't otherwise
    // observable through stdout.
    public class NoteAttribute : Attribute
    {
        public string Text { get; }

        public NoteAttribute(string text)
        {
            Text = text;
        }
    }

    [Note("hand-written note")]
    public class AnnotatedGadget
    {
    }

    public static class AttributeListFixture
    {
        public static void Run()
        {
            // CS0618 warnings are expected here; the corpus builds with warnings allowed.
            LegacyGadget gadget = new LegacyGadget();
            Console.WriteLine("AttributeList: old=" + gadget.OldWay(41).ToString());
            Console.WriteLine("AttributeList: renew=" + gadget.Renew(40).ToString());

            NoteAttribute note = typeof(AnnotatedGadget).GetCustomAttributes(true)
                .OfType<NoteAttribute>()
                .First();
            Console.WriteLine("AttributeList: note=" + note.Text);
        }
    }
}
