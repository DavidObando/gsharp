// <copyright file="Issue4628AccessorArrayNullTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4628: <c>Issue4589ExplicitPropertyAccessorEmitTests</c> collected
/// <c>new[] { property.GetMethod, property.SetMethod }.OfType&lt;MethodInfo&gt;()</c>.
/// <c>SetMethod</c> is null for a get-only property, and cs2gs bridges each
/// possibly-null array element with a fail-fast <c>!!</c> (the settled policy;
/// see #4612), so the migrated test threw where the C# filtered the null. The
/// test now adds only the accessors that exist.
/// </summary>
public class Issue4628AccessorArrayNullTests
{
    /// <summary>
    /// The discriminating witness (ADR-0154): migrate the real test file in its
    /// own project, exactly as the self-migration does, and reject any
    /// fail-fast bridge on a property accessor read.
    /// </summary>
    [Fact]
    public async Task CoreTestsSelfMigration_NeverAssertsAPropertyAccessor()
    {
        // G# translated from the C# until the cut-over, the committed .gs after (#4661).
        var files = await SelfMigratedCompilerSource.LoadAsync(
            "test/Core.Tests",
            preservePartialParts: true,
            "Issue4589ExplicitPropertyAccessorEmitTests");
        string printed = SelfMigratedCompilerSource.Compact(files["Issue4589ExplicitPropertyAccessorEmitTests"].Text);

        Assert.Contains("PropertyAccessors_AreSpecialName", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("GetMethod!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("SetMethod!!", printed, StringComparison.Ordinal);
    }
}
