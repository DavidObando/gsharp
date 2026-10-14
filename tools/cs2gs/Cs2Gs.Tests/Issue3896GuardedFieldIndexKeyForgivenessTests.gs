// <copyright file="Issue3896GuardedFieldIndexKeyForgivenessTests.cs" company="GSharp">
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

/// Issue #3896: a nullable FIELD/PROPERTY used as an indexer key inside the
/// branch of its own null-check guard was translated bare.
/// `IndexArgumentValueNeedsNullForgiveness` suppressed the assertion
/// whenever a null-check guard dominated the use — which is only sound for the
/// storage gsc actually smart-casts. gsc follows Kotlin and smart-casts locals
/// and parameters, never a mutable field/property, so the guarded key stayed
/// `T?` against a `T` key parameter and the migrated file failed to
/// compile with GS0155.
///
/// The asymmetry that exposed it: in the SAME method the ordinary
/// argument path already asserted the identical read (issue #2202's rule in
/// `ReceiverNeedsNullForgiveness`), so
/// `map.TryGetValue(n.Syntax!!, out v)` was emitted next to a bare
/// `map[n.Syntax] = v`. This is the shape from
/// `src/Core/.../ClosureEmitter.cs` that cost the self-migration gate
/// six banked apps.
open class Issue3896GuardedFieldIndexKeyForgivenessTests {
    @Fact
    func GuardedNullablePropertyIndexKey_AssignmentTarget_EmitsNonNullAssertion() {
        let printed = TranslateUnit(`
#nullable enable
using System.Collections.Generic;
namespace Demo
{
    public class Key { }
    public class Node { public Key? Anchor { get; private set; } }
    public class C
    {
        private readonly Dictionary<Key, int> map = new Dictionary<Key, int>();
        public void Record(Node n)
        {
            if (n.Anchor != null)
            {
                map[n.Anchor] = 1;
            }
        }
    }
}`)
        Assert.Contains("[n.Anchor!!] = 1", printed)
    }

    @Fact
    func GuardedNullablePropertyIndexKey_ReadPosition_EmitsNonNullAssertion() {
        let printed = TranslateUnit(`
#nullable enable
using System.Collections.Generic;
namespace Demo
{
    public class Key { }
    public class Node { public Key? Anchor { get; private set; } }
    public class C
    {
        private readonly Dictionary<Key, int> map = new Dictionary<Key, int>();
        public int Read(Node n)
        {
            if (n.Anchor != null)
            {
                return map[n.Anchor];
            }

            return 0;
        }
    }
}`)
        Assert.Contains("map[n.Anchor!!]", printed)
    }

    @Fact
    func GuardedNullableLocalIndexKey_StaysBare() {
        // Precision guard: gsc DOES smart-cast a guarded local, so the
        // suppression this fix narrowed must still apply there — otherwise the
        // fix would trade a compile error for a corpus-wide `!!` flood.
        let printed = TranslateUnit(`
#nullable enable
using System.Collections.Generic;
namespace Demo
{
    public class Key { }
    public class C
    {
        private readonly Dictionary<Key, int> map = new Dictionary<Key, int>();
        public void Record(Key? k)
        {
            if (k != null)
            {
                map[k] = 1;
            }
        }
    }
}`)
        Assert.Contains("[k] = 1", printed)
        Assert.DoesNotContain("k!!", printed)
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
