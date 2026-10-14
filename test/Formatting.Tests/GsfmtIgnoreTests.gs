// <copyright file="GsfmtIgnoreTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Formatting.Tests

import GSharp.Gsfmt
import System
import System.IO
import Xunit

class GsfmtIgnoreTests {
    @Fact
    func IsIgnored_UsesNearestAncestorRulesAndGeneratedExclusion() {
        let root = Path.Combine(Path.GetTempPath(), "gsfmt-ignore-" + Guid.NewGuid().ToString("N"))
        let ignored = Path.Combine(root, "generated", "nested", "Ignored.gs")
        let included = Path.Combine(root, "generated", "Keep.gs")
        let generated = Path.Combine(root, "Generated.g.gs")
        Directory.CreateDirectory(Path.GetDirectoryName(ignored)!!)
        File.WriteAllText(Path.Combine(root, ".gsfmtignore"), `generated/**
!generated/Keep.gs
`)
        File.WriteAllText(ignored, string.Empty)
        File.WriteAllText(included, string.Empty)
        File.WriteAllText(generated, string.Empty)
        try {
            Assert.True(IgnoreMatcher.IsIgnored(ignored, root))
            Assert.False(IgnoreMatcher.IsIgnored(included, root))
            Assert.True(IgnoreMatcher.IsIgnored(generated, root))
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    func IsIgnored_ExcludesBuildOutputOnlyBelowTheSearchRoot() {
        let root = Path.Combine(Path.GetTempPath(), "out", "gsfmt-ignore-" + Guid.NewGuid().ToString("N"))
        let source = Path.Combine(root, "Source.gs")
        let output = Path.Combine(root, "obj", "Generated.gs")
        Directory.CreateDirectory(Path.GetDirectoryName(output)!!)
        File.WriteAllText(source, string.Empty)
        File.WriteAllText(output, string.Empty)
        try {
            Assert.False(IgnoreMatcher.IsIgnored(source, root))
            Assert.True(IgnoreMatcher.IsIgnored(output, root))
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }
}
