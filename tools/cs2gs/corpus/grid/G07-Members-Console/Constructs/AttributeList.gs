// inventory: AttributeList — BCL attributes applied to a type and a member,
// a user-defined attribute class applied to a type (issue #1921, fixed), and
// (issue #1913, fixed) a user-defined attribute applied to a PARAMETER.

package Corpus.Grid07

import System
import System.Linq
import System.Reflection

@Obsolete("legacy type kept for the attribute fixture")
open class LegacyGadget {
    @Obsolete("use Renew instead")
    func OldWay(seed int32) int32 {
        return seed + 1
    }

    func Renew(seed int32) int32 {
        return seed + 2
    }
}

// Issue #1921: user-defined attribute class — a plain `: Attribute` base
// clause (translated verbatim, no `@Attribute` sugar needed) used to be
// rejected by gsc with GS0200 "Type 'NoteAttribute' is not an attribute
// class". Both the declaration and the application are exercised below;
// the applied instance and its constructor argument are read back via
// reflection since custom-attribute application isn't otherwise
// observable through stdout.
open class NoteAttribute : Attribute {
    prop Text string {
        get;
    }

    init(text string) {
        Text = text
    }
}

@Note("hand-written note")
open class AnnotatedGadget { }

// Issue #1913: an attribute on a PARAMETER (e.g. `[Note] int seed`) used to
// be silently dropped from the emitted G# — no diagnostic, and not
// observable via stdout without reflection (which is exactly why this
// probe reads the parameter's custom attributes back via `MethodInfo`
// rather than just exercising the method's return value).
open class GaugedGadget {
    func Measure(@Note("gauged seed") seed int32) int32 {
        return seed * 2
    }
}

shared class AttributeListFixture {
    func Run() {
        // CS0618 warnings are expected here; the corpus builds with warnings allowed.
        let gadget = LegacyGadget()
        Console.WriteLine("AttributeList: old=" + gadget.OldWay(41).ToString())
        Console.WriteLine("AttributeList: renew=" + gadget.Renew(40).ToString())
        let note = typeof(AnnotatedGadget).GetCustomAttributes(true).OfType[NoteAttribute]().First()
        Console.WriteLine("AttributeList: note=" + note.Text)
        let seedParameter = typeof(GaugedGadget).GetMethod("Measure")!!.GetParameters().Single()
        let paramNote = seedParameter.GetCustomAttributes(true).OfType[NoteAttribute]().First()
        Console.WriteLine("AttributeList: paramNote=" + paramNote.Text)
        let gaugedGadget = GaugedGadget()
        Console.WriteLine("AttributeList: measured=" + gaugedGadget.Measure(21).ToString())
    }
}
