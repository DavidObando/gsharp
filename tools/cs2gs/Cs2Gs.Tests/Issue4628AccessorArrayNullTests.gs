// <copyright file="Issue4628AccessorArrayNullTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.IO
import System.Threading.Tasks
import Xunit

/// Issue #4628: `Issue4589ExplicitPropertyAccessorEmitTests` collected
/// `new[] { property.GetMethod, property.SetMethod }.OfType<MethodInfo>()`.
/// `SetMethod` is null for a get-only property, and cs2gs bridges each
/// possibly-null array element with a fail-fast `!!` (the settled policy;
/// see #4612), so the migrated test threw where the C# filtered the null. The
/// test now adds only the accessors that exist.
open class Issue4628AccessorArrayNullTests {
    /// The discriminating witness (ADR-0154): migrate the real test file in its
    /// own project, exactly as the self-migration does, and reject any
    /// fail-fast bridge on a property accessor read.
    @Fact
    async func CoreTestsSelfMigration_NeverAssertsAPropertyAccessor() {
        // G# translated from the C# until the cut-over, the committed .gs after (#4661).
        let files = await SelfMigratedCompilerSource.LoadAsync(
            "test/Core.Tests",
            preservePartialParts: true,
            "Issue4589ExplicitPropertyAccessorEmitTests"
        )
        let printed = SelfMigratedCompilerSource.Compact(files["Issue4589ExplicitPropertyAccessorEmitTests"].Text)
        Assert.Contains("PropertyAccessors_AreSpecialName", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("GetMethod!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("SetMethod!!", printed, StringComparison.Ordinal)
    }
}
