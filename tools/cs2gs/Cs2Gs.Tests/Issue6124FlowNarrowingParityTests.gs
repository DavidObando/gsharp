// Copyright (C) GSharp Authors. All rights reserved.

package Cs2Gs.Tests

import System
import System.Text
import Xunit

class Issue6124FlowNarrowingParityTests {
    @Fact
    func OutParameter_StringNullGuardOrChain_EmitsRequiredAssertionsAndCompiles() {
        let source = `
#nullable enable
using System;

public class Probe {
    private static bool TryParse(string? a, string? b, out string? sourceType, out string? targetType) {
        sourceType = a;
        targetType = b;
        if (string.IsNullOrEmpty(sourceType) || string.IsNullOrEmpty(targetType)) {
            return false;
        }
        if (!sourceType.EndsWith("?", StringComparison.Ordinal)) {
            return false;
        }
        var underlying = sourceType.Substring(0, sourceType.Length - 1);
        return string.Equals(underlying, targetType, StringComparison.Ordinal);
    }

    private static bool SingleGuard(string? a, out string? sourceType) {
        sourceType = a;
        if (string.IsNullOrEmpty(sourceType)) {
            return false;
        }
        return sourceType.EndsWith("?", StringComparison.Ordinal);
    }

    private static bool MixedNilAndCallOrGuard(string? a, string? b, out string? sourceType, out string? targetType) {
        sourceType = a;
        targetType = b;
        if (sourceType == null || string.IsNullOrEmpty(targetType)) {
            return false;
        }
        return sourceType.EndsWith("?", StringComparison.Ordinal);
    }

    public static void Main() {
        Console.Write(
            TryParse("string?", "string", out _, out _) + "|" +
            TryParse(null, "string", out _, out _) + "|" +
            SingleGuard("int?", out _) + "|" +
            MixedNilAndCallOrGuard("bool?", "bool", out _, out _) + "|" +
            MixedNilAndCallOrGuard(null, "bool", out _, out _));
    }
}
`
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (printed string) -> {
                Issue5585ReadonlyNullArgumentTests.AssertClean(printed)
                Assert.Contains("sourceType!!.EndsWith", printed, StringComparison.Ordinal)
                Assert.Contains("sourceType!!.Substring", printed, StringComparison.Ordinal)
                Assert.Contains("sourceType!!.Length", printed, StringComparison.Ordinal)
            },
            verifyAssembly: (assembly string) -> {
                Issue5585ReadonlyNullArgumentTests.VerifyStrictIL(assembly)
            },
            expectedOutput: "True|False|True|True|False"
        )
    }

    @Fact
    func OutParameter_GenuineGscNarrowing_KeepsAssertionsOmitted() {
        let source = `
#nullable enable
using System;

public enum State {
    None,
    Done
}

public class Probe {
    private static readonly bool StaticFlag = false;

    private bool Flag { get; }

    private static bool PlainParams(string? sourceType, string? targetType) {
        if (string.IsNullOrEmpty(sourceType) || string.IsNullOrEmpty(targetType)) {
            return false;
        }
        return sourceType.EndsWith("?", StringComparison.Ordinal);
    }

    private static bool OutInElseBranch(string? a, out string? sourceType) {
        sourceType = a;
        if (string.IsNullOrEmpty(sourceType)) {
            return false;
        } else {
            return sourceType.EndsWith("?", StringComparison.Ordinal);
        }
    }

    private static bool OutWithCallFreeNilGuard(string? a, out string? sourceType) {
        sourceType = a;
        if (sourceType == null) {
            return false;
        }
        return sourceType.EndsWith("?", StringComparison.Ordinal);
    }

    private static bool OutWithArrayReadNilGuard(string? a, bool[] flags, out string? p) {
        p = a;
        if (p == null || flags[0]) {
            return false;
        }
        return p.EndsWith("?", StringComparison.Ordinal);
    }

    private bool OutWithQualifiedAutoProp(string? a, out string? p) {
        p = a;
        if (p == null || this.Flag) {
            return false;
        }
        return p.EndsWith("?", StringComparison.Ordinal);
    }

    private bool OutWithUnqualifiedAutoProp(string? a, out string? p) {
        p = a;
        if (p == null || Flag) {
            return false;
        }
        return p.EndsWith("?", StringComparison.Ordinal);
    }

    private static bool OutWithNullableHasValue(string? a, int? n, out string? p) {
        p = a;
        if (p == null || n.HasValue) {
            return false;
        }
        return p.EndsWith("?", StringComparison.Ordinal);
    }

    private static bool OutWithStaticSourceField(string? a, out string? p) {
        p = a;
        if (p == null || StaticFlag) {
            return false;
        }
        return p.EndsWith("?", StringComparison.Ordinal);
    }

    private static bool RefWithEnumCompare(ref string? p, State state) {
        if (p == null || state == State.Done) {
            return false;
        }
        return p.EndsWith("?", StringComparison.Ordinal);
    }

    public static void Main() {
        var probe = new Probe();
        string? refVal = "enum?";
        Console.Write(
            PlainParams("string?", "string") + "|" +
            OutInElseBranch("int?", out _) + "|" +
            OutWithCallFreeNilGuard("bool?", out _) + "|" +
            OutWithArrayReadNilGuard("char?", new[] { false }, out _) + "|" +
            probe.OutWithQualifiedAutoProp("byte?", out _) + "|" +
            probe.OutWithUnqualifiedAutoProp("short?", out _) + "|" +
            OutWithNullableHasValue("long?", null, out _) + "|" +
            OutWithStaticSourceField("float?", out _) + "|" +
            RefWithEnumCompare(ref refVal, State.None));
    }
}
`
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (printed string) -> {
                Issue5585ReadonlyNullArgumentTests.AssertClean(printed)
                Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
            },
            verifyAssembly: (assembly string) -> {
                Issue5585ReadonlyNullArgumentTests.VerifyStrictIL(assembly)
            },
            expectedOutput: "True|True|True|True|True|True|True|True|True"
        )
    }

    @Fact
    func ReadonlyFieldInAnd_WithInterveningClrMemberAccess_EmitsAssertionAndCompiles() {
        let source = `
#nullable enable
using System;
using System.Collections.Generic;

public class Probe {
    private readonly string? entryType;
    private readonly int[] items = new int[] { 0 };

    public Probe(string? entryType) {
        this.entryType = entryType;
    }

    private bool Check() => false;

    public bool MatchesAfterClrMember(string? other) {
        if (other == null
            || (this.entryType != null
                && EqualityComparer<int>.Default.Equals(other?.Length ?? 0, this.entryType.Length))) {
            return false;
        }
        return true;
    }

    public bool NestedCallInSameOperand() {
        return this.entryType != null && (Check() || this.entryType.Length > 0);
    }

    public int MemberWriteInSiblingOperand() {
        if (this.entryType != null && (items[0] = 1) == 0) {
            return this.entryType.Length;
        }
        return 0;
    }

    public static void Main() {
        Console.Write(
            new Probe("abc").MatchesAfterClrMember("wxyz") + "|" +
            new Probe("abc").MatchesAfterClrMember("xyz") + "|" +
            new Probe("abc").NestedCallInSameOperand() + "|" +
            new Probe("abc").MemberWriteInSiblingOperand());
    }
}
`
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (printed string) -> {
                Issue5585ReadonlyNullArgumentTests.AssertClean(printed)
                Assert.Contains("this.entryType!!.Length", printed, StringComparison.Ordinal)
            },
            verifyAssembly: (assembly string) -> {
                Issue5585ReadonlyNullArgumentTests.VerifyStrictIL(assembly)
            },
            expectedOutput: "True|False|True|0"
        )
    }

    @Fact
    func ReadonlyFieldInAnd_WithoutInterveningInvalidation_KeepsAssertionOmitted() {
        let source = `
#nullable enable
using System;
using System.Collections.Generic;

public struct Counters {
    public static int Value;
    public int InstanceValue;
}

public class Probe {
    private readonly string? entryType;
    private int count;
    private Counters counter;

    public Probe(string? entryType) {
        this.entryType = entryType;
    }

    private bool Check() => true;

    public bool DirectInAnd() {
        return this.entryType != null && this.entryType.Length > 0;
    }

    public int CrossOperandCallBeforeIfBody() {
        if (this.entryType != null && EqualityComparer<int>.Default.Equals(0, 0)) {
            return this.entryType.Length;
        }
        return 0;
    }

    public bool ChainedAndCall() {
        return (this.entryType != null && Check()) && this.entryType.Length > 0;
    }

    public int SeparateFieldWriteInSiblingOperand() {
        if (this.entryType != null && (this.count = 1) == 1) {
            return this.entryType.Length;
        }
        return 0;
    }

    public int StaticStructFieldWriteInSiblingOperand() {
        if (this.entryType != null && (Counters.Value = 1) == 1) {
            return this.entryType.Length;
        }
        return 0;
    }

    public int UnqualifiedStructFieldWriteInSiblingOperand() {
        if (this.entryType != null && (counter.InstanceValue = 1) == 1) {
            return this.entryType.Length;
        }
        return 0;
    }

    public static void Main() {
        Console.Write(
            new Probe("abc").DirectInAnd() + "|" +
            new Probe("abc").CrossOperandCallBeforeIfBody() + "|" +
            new Probe("abc").ChainedAndCall() + "|" +
            new Probe("abc").SeparateFieldWriteInSiblingOperand() + "|" +
            new Probe("abc").StaticStructFieldWriteInSiblingOperand() + "|" +
            new Probe("abc").UnqualifiedStructFieldWriteInSiblingOperand());
    }
}
`
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (printed string) -> {
                Issue5585ReadonlyNullArgumentTests.AssertClean(printed)
                Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
            },
            verifyAssembly: (assembly string) -> {
                Issue5585ReadonlyNullArgumentTests.VerifyStrictIL(assembly)
            },
            expectedOutput: "True|3|True|3|3|3"
        )
    }
}
