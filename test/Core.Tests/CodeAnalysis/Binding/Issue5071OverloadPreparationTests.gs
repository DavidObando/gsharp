package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.IO
import System.Reflection
import Xunit

class Issue5071OverloadPreparationTests {
    @Fact
    func NormalForm_ReusesItsRawParametersButNotAnotherRequestsParameters() {
        using let fixture = CSharpFixture("public class Contract { public static int Normal(int value = 7) => value; }")
        let method = ParameterProbe(fixture.Load().GetType("Contract")!!.GetMethod("Normal")!!)
        let callbacks = List[int32]()
        for var request = 0; request < 2; request++ {
            let result = ClrOverloadResolution.Resolve(
                []MethodInfo{method},
                Array.Empty[Type](),
                trailingParameterCountToIgnore: (_ MethodBase) -> {
                    callbacks.Add(method.Reads)
                    return 0
                }
            )
            Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
            Assert.Same(method, result.Best)
            Assert.False(result.IsExpanded)
            Assert.Equal(request + 1, method.Reads)
        }
        Assert.Equal([]int32{0, 1}, callbacks)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ExpandedForm_ReadsFreshParametersAndRetriesFailedNormalReads(failFirst bool) {
        using let fixture = CSharpFixture("public class Contract { public static void Pack(params int[] values) {} }")
        let method = ParameterProbe(fixture.Load().GetType("Contract")!!.GetMethod("Pack")!!, failFirst)
        let callbacks = List[int32]()
        let result = ClrOverloadResolution.Resolve(
            []MethodInfo{method},
            Array.Empty[Type](),
            trailingParameterCountToIgnore: (_ MethodBase) -> {
                callbacks.Add(method.Reads)
                return 0
            }
        )
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.Same(method, result.Best)
        Assert.True(result.IsExpanded)
        Assert.Equal(2, method.Reads)
        Assert.Equal([]int32{0, 2}, callbacks)
    }

    @Fact
    func ClosedGenericParametersAndInferenceRemainFormSpecific() {
        using let fixture = CSharpFixture("public class Contract { public static void Pack<T>(params T[] values) {} }")
        let method = fixture.Load().GetType("Contract")!!.GetMethod("Pack")!!
        let forms = List[bool]()
        let recover = (closed MethodInfo, expanded bool) -> {
            forms.Add(expanded)
            return default(ImmutableArray[GSharp.Core.CodeAnalysis.Symbols.TypeSymbol?])
        }
        let normal = ClrOverloadResolution.Resolve(
            []MethodInfo{method},
            []Type{typeof([]string)},
            recoverTypeArgSymbols: recover
        )
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, normal.Outcome)
        Assert.False(normal.IsExpanded)
        Assert.Equal(typeof(string), Assert.Single(normal.Best!!.GetGenericArguments()))
        Assert.NotEmpty(forms)
        Assert.DoesNotContain(true, forms)
        forms.Clear()
        let expanded = ClrOverloadResolution.Resolve(
            []MethodInfo{method},
            []Type{typeof([]string), typeof([]string)},
            recoverTypeArgSymbols: recover
        )
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, expanded.Outcome)
        Assert.True(expanded.IsExpanded)
        Assert.Equal(typeof([]string), Assert.Single(expanded.Best!!.GetGenericArguments()))
        Assert.Contains(false, forms)
        Assert.Contains(true, forms)
    }

    private class ParameterProbe : MethodInfo {
        private let method MethodInfo
        private let failFirst bool
        internal var Reads int32

        internal init(method MethodInfo, failFirst bool = false) {
            this.method = method
            this.failFirst = failFirst
        }

        override func GetParameters()[]ParameterInfo {
            Reads++
            if failFirst && Reads == 1 {
                throw FileNotFoundException("retryable candidate signature")
            }
            return method.GetParameters()
        }

        override prop Name string -> method.Name
        override prop DeclaringType Type? -> method.DeclaringType
        override prop ReflectedType Type? -> method.ReflectedType
        override prop Attributes MethodAttributes -> method.Attributes
        override prop MethodHandle RuntimeMethodHandle -> method.MethodHandle
        override prop ReturnType Type -> method.ReturnType
        override prop ReturnTypeCustomAttributes ICustomAttributeProvider -> method.ReturnTypeCustomAttributes

        override func GetBaseDefinition() MethodInfo -> method.GetBaseDefinition()

        override func GetMethodImplementationFlags() MethodImplAttributes -> method.GetMethodImplementationFlags()

        override func GetCustomAttributes(inherit bool)[]object -> method.GetCustomAttributes(inherit)

        override func GetCustomAttributes(attributeType Type, inherit bool)[]object -> method.GetCustomAttributes(
            attributeType,
            inherit
        )

        override func IsDefined(attributeType Type, inherit bool) bool -> method.IsDefined(attributeType, inherit)

        override func Invoke(
            obj object?,
            invokeAttr BindingFlags,
            binder System.Reflection.Binder?,
            parameters[]?object?,
            culture CultureInfo?
        ) object? -> method.Invoke(obj, invokeAttr, binder, parameters, culture)
    }
}
