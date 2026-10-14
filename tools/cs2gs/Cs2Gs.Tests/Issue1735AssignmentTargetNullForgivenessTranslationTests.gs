// <copyright file="Issue1735AssignmentTargetNullForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Translator-fidelity tests for issue #1735, three follow-up gaps in the
/// nullable-receiver `!!` assertion machinery added by #1594/#1598:
/// 1. (cref:CSharpToGSharpTranslator)'s assignment-target path (`TranslateAssignmentTarget`) returned
/// early for an implicit-this instance property/field receiver, so a nullable receiver on the LEFT of
/// an assignment never got the same `!!` its read-side twin gets — emitting an unforgiven
/// `this.Prop.Member = v` (GS0158) instead of `this.Prop!!.Member = v`.
/// 2. Owned struct methods now stay in-body, so that same branch must qualify their nullable instance
/// receivers through real `this`.
/// 3. A delegate/event invoked via the explicit `.Invoke(...)` spelling bypassed the #1598
/// callee-forgiveness path entirely (only the direct-call sugar `d(args)` routed through it), so a
/// nullable delegate field invoked as `field.Invoke(x)` emitted a bare, unforgiven `field(x)` (GS0131).
open class Issue1735AssignmentTargetNullForgivenessTranslationTests {
    @Fact
    func ImplicitThisNullableProperty_AssignmentTarget_EmitsNonNullAssertion() {
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class Inner { public int Value; }
    public class C
    {
        private Inner? Child => new Inner();
        public void F()
        {
            if (Child == null) return;
            Child.Value = 5;
        }
    }
}`)
        Assert.Contains("this.Child!!.Value = 5", printed)
    }

    @Fact
    func ExplicitNullableReceiver_AssignmentTarget_EmitsNonNullAssertion() {
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class Inner { public int Value; }
    public class Outer { public Inner? Child => null; }
    public class C
    {
        public void F(Outer o)
        {
            if (o.Child == null) return;
            o.Child.Value = 5;
        }
    }
}`)
        Assert.Contains("o.Child!!.Value = 5", printed)
    }

    @Fact
    func OwnedStructInBodyMethod_ImplicitThisNullableField_UsesThis() {
        // Issue #2821: owned struct methods now use the canonical in-body form.
        // Nullable assignment-target qualification therefore uses real `this`.
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class Inner { public int Value; }
    public struct Vec
    {
        public Inner? Child;
        public void F()
        {
            if (Child == null) return;
            Child.Value = 5;
        }
    }
}`)
        Assert.DoesNotContain("func (self Vec)", printed)
        Assert.Contains("this.Child!!.Value = 5", printed)
    }

    @Fact
    func NonNullableReceiver_AssignmentTarget_DoesNotAssert() {
        // Precision guard: a non-nullable implicit-this property/field receiver
        // still needs the `this.` qualification (GS0158/GS9998) but must never
        // get a spurious `!!`.
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class Inner { public int Value; }
    public class C
    {
        private Inner Child { get; } = new Inner();
        public void F()
        {
            Child.Value = 5;
        }
    }
}`)
        Assert.Contains("this.Child.Value = 5", printed)
        Assert.DoesNotContain("!!", printed)
    }

    @Fact
    func NullableDelegateField_ExplicitInvokeSpelling_EmitsNonNullAssertion() {
        // Issue #1598 forgives the callee of the direct-call sugar `field(x)`.
        // The explicit `.Invoke(x)` spelling must be forgiven identically.
        let printed = TranslateUnit(`
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        private Action<int>? handler;
        public void F()
        {
            if (handler == null) return;
            handler.Invoke(1);
        }
    }
}`)
        // Issue #4262 follow-up (item 2): `handler` is a NON-readonly field,
        // so it is not a stable access path — the local-capture rewrite
        // deliberately excludes it, leaving the original per-use `!!` in
        // place at this call-sugar site.
        Assert.Contains("handler!!(1)", printed)
    }

    @Fact
    func NonNullableDelegateField_ExplicitInvokeSpelling_DoesNotAssert() {
        let printed = TranslateUnit(`
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        private Action<int> handler = _ => { };
        public void F()
        {
            handler.Invoke(1);
        }
    }
}`)
        Assert.DoesNotContain("!!", printed)
        Assert.Contains("handler(1)", printed)
    }

    shared {
        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
