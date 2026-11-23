// Copyright (C) GSharp Authors. All rights reserved.

package Cs2Gs.Tests

import Microsoft.CodeAnalysis
import System
import Xunit

/// Issue #5954: `IsGSharpFlowNarrowedFieldOrPropertyInSameCondition` must climb past
/// comparisons, arithmetic, casts, invocations/arguments, conditional expressions, and
/// nested `&&`/`||` inside the guarded right operand, while preserving `!!` whenever an
/// intervening evaluation, mutation, closure/by-ref root, or unstable member invalidates
/// G# smart-cast narrowing.
class Issue5954StablePathComparisonNarrowingTests {
    @Fact
    func ExactReproAndObliviousStablePaths_OmitRedundantAssertionsAndMatchRuntime() {
        let source = `
using System;

namespace Demo
{
    public class Node
    {
        public Node Child { get; }
        public int Value;
        public Node(Node child, int value) { Child = child; Value = value; }
        public override string ToString() => "node:" + Value;
    }

    public record Entry(Node Item, int Id);

    public static class Use
    {
        public static Entry Empty() => new Entry(null, 0);

        public static string StablePath(Entry entry)
        {
            var item = entry.Item;
            if (item == null) return "null";
            return item.Child == null || item.Child.Value == 0 ? "node" : "bad";
        }

        public static bool AndComparison(Entry entry)
        {
            var item = entry.Item;
            if (item == null) return false;
            return item.Child != null && item.Child.Value == 0;
        }

        public static bool NestedArithmetic(Entry entry)
        {
            var item = entry.Item;
            if (item == null) return false;
            return item.Child != null && (item.Child.Value + 1) > 0;
        }

        public static bool TernaryInsideOr(Entry entry, bool flag)
        {
            var item = entry.Item;
            if (item == null) return false;
            return item.Child == null || (flag ? item.Child.Value == 0 : false);
        }

        public static bool NegatedOr(Entry entry)
        {
            var item = entry.Item;
            if (item == null) return false;
            return !(item.Child == null || item.Child.Value == 0);
        }

        public static int IfAndWhileConditions(Entry entry)
        {
            var item = entry.Item;
            if (item == null) return 0;
            int sum = 0;
            if (item.Child != null && item.Child.Value > 0)
            {
                sum += 1;
            }
            while (item.Child != null && item.Child.Value > 0 && sum == 1)
            {
                sum += 4;
            }
            return sum;
        }

        public static void Main()
        {
            var zero = new Entry(new Node(new Node(null, 0), 1), 1);
            var nonZero = new Entry(new Node(new Node(null, 5), 1), 2);
            var noChild = new Entry(new Node(null, 1), 3);
            Console.Write(
                StablePath(Empty()) + "|" +
                StablePath(noChild) + "|" +
                StablePath(zero) + "|" +
                StablePath(nonZero) + "|" +
                AndComparison(zero) + "|" +
                AndComparison(noChild) + "|" +
                NestedArithmetic(zero) + "|" +
                TernaryInsideOr(zero, true) + "|" +
                TernaryInsideOr(nonZero, false) + "|" +
                NegatedOr(zero) + "|" +
                NegatedOr(nonZero) + "|" +
                IfAndWhileConditions(nonZero));
        }
    }
}
`
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (printed string) -> {
                Issue5585ReadonlyNullArgumentTests.AssertClean(printed)
                Assert.Contains("if item.Child == nil || item.Child.Value == 0", printed, StringComparison.Ordinal)
                Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
            },
            verifyIL: true,
            verifyAssembly: (assembly string) -> {
                Issue5585ReadonlyNullArgumentTests.VerifyStrictIL(assembly)
            },
            nullableContextOptions: NullableContextOptions.Disable,
            expectedOutput: "null|node|node|bad|True|False|True|True|False|False|True|5"
        )
    }

    @Fact
    func NullableEnabled_CompoundPatternsCastsCallsAfterRead_OmitAssertionsAndMatchRuntime() {
        let source = `
#nullable enable
using System;

namespace Demo
{
    public class Node
    {
        public Node? Child { get; }
        public Node? InitChild { get; init; }
        public readonly Node? ReadonlyChild;
        public int Value;
        public int MutableField;

        public Node(Node? child, int value)
        {
            Child = child;
            InitChild = child;
            ReadonlyChild = child;
            Value = value;
        }
    }

    public sealed class SubNode : Node
    {
        public int Extra;
        public SubNode(Node? child, int value, int extra) : base(child, value)
        {
            Extra = extra;
        }
    }

    public static class Probe
    {
        private static bool Check() => true;
        private static int TakeNonNull(Node n) => n.Value;

        public static bool IsNotNullAndCompare(Node item) =>
            item.Child is not null && item.Child.Value == 0;

        public static bool IsSubtypeCast(Node item) =>
            item.Child is SubNode && ((SubNode)item.Child).Extra == 7;

        public static bool IsPropertyPatternField(Node item) =>
            item.Child is Node { Value: 0 } && item.Child.Value == 0;

        public static bool ChainedAndWithFlag(Node item, bool flag) =>
            flag && item.Child != null && item.Child.Value == 0;

        public static bool ChainedOrWithFlag(Node item, bool flag) =>
            flag || item.Child == null || item.Child.Value == 0;

        public static bool NestedAndRight(Node item, Node other) =>
            item.Child != null && (other.Child != null && item.Child.Value == 0);

        public static bool MultiLevelChain(Node a) =>
            a.Child != null && a.Child.Child != null && a.Child.Child.Value == 0;

        public static bool ArgumentPositionInOr(Node item) =>
            item.Child == null || TakeNonNull(item.Child) == 0;

        public static bool CallAfterRead(Node item) =>
            item.Child != null && (item.Child.Value == 0 || Check());

        public static bool CallInLeftSibling(Node item) =>
            (item.Child != null && Check()) && item.Child.Value == 0;

        public static bool SeparateFieldWriteBefore(Node item, Node other) =>
            item.Child != null && ((other.MutableField = 1) == 0 || item.Child.Value == 0);

        public static bool ReadonlyAndInitLinks(Node item) =>
            item.ReadonlyChild != null && item.ReadonlyChild.Value == 0 &&
            item.InitChild != null && item.InitChild.Value == 0;

        public static void Main()
        {
            var leaf = new Node(null, 0);
            var sub = new SubNode(leaf, 0, 7);
            var item = new Node(sub, 1);
            var other = new Node(leaf, 2);
            Console.Write(
                IsNotNullAndCompare(item) + "|" +
                IsSubtypeCast(item) + "|" +
                IsPropertyPatternField(item) + "|" +
                ChainedAndWithFlag(item, true) + "|" +
                ChainedOrWithFlag(item, false) + "|" +
                NestedAndRight(item, other) + "|" +
                MultiLevelChain(item) + "|" +
                ArgumentPositionInOr(item) + "|" +
                CallAfterRead(item) + "|" +
                CallInLeftSibling(item) + "|" +
                SeparateFieldWriteBefore(item, other) + "|" +
                ReadonlyAndInitLinks(item));
        }
    }
}
`
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (printed string) -> {
                Issue5585ReadonlyNullArgumentTests.AssertClean(printed)
                Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
            },
            verifyIL: true,
            verifyAssembly: (assembly string) -> {
                Issue5585ReadonlyNullArgumentTests.VerifyStrictIL(assembly)
            },
            expectedOutput: "True|True|True|True|True|True|True|True|True|True|True|True"
        )
    }

    @Fact
    func InvalidatedOrUnstablePaths_PreserveAssertionsAndRuntimeParity() {
        let source = `
#nullable enable
using System;

namespace Demo
{
    public class Node
    {
        public Node? Child { get; }
        public Node? MutableChild { get; set; }
        public virtual Node? VirtualChild { get; }
        private readonly Node? backing;
        public Node? ComputedChild => backing;
        public static Node? StaticChild { get; }
        public int Value;
        public int ComputedProp => 0;

        public Node(Node? child, int value)
        {
            Child = child;
            MutableChild = child;
            VirtualChild = child;
            backing = child;
            Value = value;
        }
    }

    public sealed class Holder
    {
        public bool Accept(int x) => x == 0;
    }

    public struct CounterBox
    {
        public int Counter;

        public bool StructThisWriteInRight(Node item) =>
            item.Child != null && (++this.Counter > 0 && item.Child.Value == 0);

        public bool StructThisWriteInLeft(Node item) =>
            (item.Child != null && ++this.Counter > 0) && item.Child.Value == 0;
    }

    public static class Probe
    {
        private static bool Check() => false;
        private static int SideEffectInt() => 0;
        private static bool Compare(int a, int b) => a == b;
        private static Holder GetHolder() => new Holder();
        private static bool Touch(ref int x) { x += 1; return true; }
        private static bool MutateNonNullRef(ref Node item, Node next) { item = next; return true; }

        public static bool CallBeforeInRightOr(Node item) =>
            item.Child != null && (Check() || item.Child.Value == 0);

        public static bool CallInEarlierArg(Node item) =>
            item.Child != null && Compare(SideEffectInt(), item.Child.Value);

        public static bool CallInInvocationReceiver(Node item) =>
            item.Child != null && GetHolder().Accept(item.Child.Value);

        public static bool ArrayWriteBefore(Node item, int[] arr) =>
            item.Child != null && ((arr[0] = 1) == 0 || item.Child.Value == 0);

        public static bool ReassignBeforeInRight(Node item, Node other) =>
            item.Child != null && (((item = other) == null) || item.Child.Value == 0);

        public static bool ReassignRefInLeft(Node item, Node other) =>
            (item.Child != null && MutateNonNullRef(ref item, other)) && item.Child.Value == 0;

        public static string ClosureMutatedCallInLeft(Node item, Node nullChildNode)
        {
            Action clear = () => { item = nullChildNode; };
            bool MutateViaClosure() { clear(); return true; }
            try
            {
                return (item.Child != null && MutateViaClosure()) && item.Child.Value == 0
                    ? "zero" : "nonzero";
            }
            catch (NullReferenceException)
            {
                return "nre";
            }
        }

        public static bool RefRootWithLeftCall(ref Node item) =>
            (item.Child != null && (Check() || true)) && item.Child.Value == 0;

        public static bool SettableProperty(Node item) =>
            item.MutableChild != null && item.MutableChild.Value == 0;

        public static bool VirtualProperty(Node item) =>
            item.VirtualChild != null && item.VirtualChild.Value == 0;

        public static bool ComputedProperty(Node item) =>
            item.ComputedChild != null && item.ComputedChild.Value == 0;

        public static bool StaticProperty() =>
            Node.StaticChild != null && Node.StaticChild.Value == 0;

        public static bool OrLeftOfAnd(Node item, Node? other) =>
            (item.Child != null || other != null) && item.Child.Value == 0;

        public static bool AndLeftOfOr(Node item, Node? other) =>
            (item.Child == null && other == null) || item.Child.Value == 0;

        public static bool ComputedSubpattern(Node item) =>
            item.Child is Node { ComputedProp: 0 } && item.Child.Value == 0;

        public static bool EmptyBracesPattern(Node item) =>
            item.Child is {} && item.Child.Value == 0;

        public static bool LambdaInsideAnd(Node item) =>
            item.Child != null && ((Func<bool>)(() => item.Child.Value == 0))();

        public static bool AssertedGuardReceiverBeforeLocalGuard(Node? item) =>
            item.Child != null && item != null && item.Child.Value == 0;

        public static bool MutableRootWithByRefFieldCallInLeft(Node item, Node other)
        {
            if (item == other) item = other;
            return (item.Child != null && Touch(ref other.Value)) && item.Child.Value == 0;
        }

        public static void Main()
        {
            var leaf = new Node(null, 0);
            var item = new Node(leaf, 1);
            var other = new Node(leaf, 2);
            var noChild = new Node(null, 3);
            var arr = new[] { 0 };
            var box = new CounterBox();
            Console.Write(
                CallBeforeInRightOr(item) + "|" +
                CallInEarlierArg(item) + "|" +
                CallInInvocationReceiver(item) + "|" +
                ArrayWriteBefore(item, arr) + "|" +
                ReassignBeforeInRight(item, other) + "|" +
                ReassignRefInLeft(item, other) + "|" +
                ClosureMutatedCallInLeft(item, noChild) + "|" +
                RefRootWithLeftCall(ref item) + "|" +
                SettableProperty(item) + "|" +
                VirtualProperty(item) + "|" +
                ComputedProperty(item) + "|" +
                StaticProperty() + "|" +
                OrLeftOfAnd(item, other) + "|" +
                AndLeftOfOr(item, other) + "|" +
                ComputedSubpattern(item) + "|" +
                EmptyBracesPattern(item) + "|" +
                LambdaInsideAnd(item) + "|" +
                AssertedGuardReceiverBeforeLocalGuard(item) + "|" +
                MutableRootWithByRefFieldCallInLeft(item, other) + "|" +
                box.StructThisWriteInRight(item) + "|" +
                box.StructThisWriteInLeft(item));
        }
    }
}
`
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (printed string) -> {
                Issue5585ReadonlyNullArgumentTests.AssertClean(printed)
                let methodNames = []string{
                    "StructThisWriteInRight",
                    "StructThisWriteInLeft",
                    "CallBeforeInRightOr",
                    "CallInEarlierArg",
                    "CallInInvocationReceiver",
                    "ArrayWriteBefore",
                    "ReassignBeforeInRight",
                    "ReassignRefInLeft",
                    "ClosureMutatedCallInLeft",
                    "RefRootWithLeftCall",
                    "SettableProperty",
                    "VirtualProperty",
                    "ComputedProperty",
                    "StaticProperty",
                    "OrLeftOfAnd",
                    "AndLeftOfOr",
                    "ComputedSubpattern",
                    "EmptyBracesPattern",
                    "LambdaInsideAnd",
                    "AssertedGuardReceiverBeforeLocalGuard",
                    "MutableRootWithByRefFieldCallInLeft"
                }
                for var i = 0; i < methodNames.Length; i++ {
                    let start = printed.IndexOf("func " + methodNames[i] + "(", StringComparison.Ordinal)
                    Assert.True(start >= 0, "Missing method " + methodNames[i])
                    let end = if i + 1 < methodNames.Length {
                        printed.IndexOf("func " + methodNames[i + 1] + "(", start, StringComparison.Ordinal)
                    } else {
                        printed.IndexOf("func Main(", start, StringComparison.Ordinal)
                    }
                    Assert.True(end > start)
                    let body = printed.Substring(start, end - start)
                    Assert.Contains("Child!!", body, StringComparison.Ordinal)
                }
            },
            verifyIL: true,
            verifyAssembly: (assembly string) -> {
                Issue5585ReadonlyNullArgumentTests.VerifyStrictIL(assembly)
            },
            expectedOutput: "True|True|True|True|True|True|nre|True|True|True|True|False|True|True|True|True|True|True|True|True|True"
        )
    }
}
