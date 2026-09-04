// <copyright file="Issue3896GuardedFieldIndexKeyForgivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3896: a nullable FIELD/PROPERTY used as an indexer key inside the
/// branch of its own null-check guard was translated bare.
/// <c>IndexArgumentValueNeedsNullForgiveness</c> suppressed the assertion
/// whenever a null-check guard dominated the use — which is only sound for the
/// storage gsc actually smart-casts. gsc follows Kotlin and smart-casts locals
/// and parameters, never a mutable field/property, so the guarded key stayed
/// <c>T?</c> against a <c>T</c> key parameter and the migrated file failed to
/// compile with GS0155.
/// <para>The asymmetry that exposed it: in the SAME method the ordinary
/// argument path already asserted the identical read (issue #2202's rule in
/// <c>ReceiverNeedsNullForgiveness</c>), so
/// <c>map.TryGetValue(n.Syntax!!, out v)</c> was emitted next to a bare
/// <c>map[n.Syntax] = v</c>. This is the shape from
/// <c>src/Core/.../ClosureEmitter.cs</c> that cost the self-migration gate
/// six banked apps.</para>
/// </summary>
public class Issue3896GuardedFieldIndexKeyForgivenessTests
{
    [Fact]
    public void GuardedNullablePropertyIndexKey_AssignmentTarget_EmitsNonNullAssertion()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("[n.Anchor!!] = 1", printed);
    }

    [Fact]
    public void GuardedNullablePropertyIndexKey_ReadPosition_EmitsNonNullAssertion()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("map[n.Anchor!!]", printed);
    }

    [Fact]
    public void GuardedNullableLocalIndexKey_StaysBare()
    {
        // Precision guard: gsc DOES smart-cast a guarded local, so the
        // suppression this fix narrowed must still apply there — otherwise the
        // fix would trade a compile error for a corpus-wide `!!` flood.
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("[k] = 1", printed);
        Assert.DoesNotContain("k!!", printed);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
