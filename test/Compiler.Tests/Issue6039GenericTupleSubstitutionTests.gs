package GSharp.Compiler.Tests

import GSharp.Tests
import System
import System.Reflection
import System.Text
import Xunit

class Issue6039GenericTupleSubstitutionTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func NullableTaskTuple_RefReturnPreservesCallerStorage(explicitArguments bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let call = if explicitArguments {
            "Slot[(string, int32)](&value)"
        } else {
            "Slot(&value)"
        }
        let dll = fixture.Compile(`import System
import System.Threading.Tasks
shared class P {
    private func Slot[T](ref value Task[T]?) ref Task[T]? { return ref value }
    func Main() {
        var value Task[(string, int32)]? = nil
        var ref alias Task[(string, int32)]? = ` + call + `
        Console.WriteLine(alias == nil)
        alias = Task.FromResult[(string, int32)](("changed", 42))
        Console.WriteLine(value!!.Result.Item1)
        Console.WriteLine(value!!.Result.Item2)
    }
}`, "Repro6039", executable: true)
        Assert.Equal(
            Encoding.UTF8.GetBytes("True\nchanged\n42\n".Replace("\n", Environment.NewLine)),
            fixture.RunBytes(dll)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func NestedTupleContracts_PreserveAliasesNamesAndSingleEvaluation(imported bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`using System.Threading.Tasks;
namespace Contracts6039;
public static class Contract {
    public static ref Task<T>? Slot<T>(ref Task<T>? value) => ref value;
    public static ref readonly Task<T>? View<T>(ref Task<T>? value) => ref value;
    public static void Set<T>(out Task<T>? value, Task<T>? next) { value = next; }
    public static Task<T>? Identity<T>(Task<T>? value) => value;
}`, "Contract6039")
        let owner = if imported {
            "Contract"
        } else {
            "P"
        }
        let dll = fixture.Compile(`package Source6039
import System
import System.Threading.Tasks
import Contracts6039
shared class P {
    var Calls int32
    func Next() int32 {
        Calls++
        return 0
    }
    func Slot[T](ref value Task[T]?) ref Task[T]? { return ref value }
    func View[T](ref value Task[T]?) ref readonly Task[T]? { return ref value }
    func Set[T](out value Task[T]?, next Task[T]?) { value = next }
    func Identity[T](value Task[T]?) Task[T]? { return value }
    func Main() {
        var direct Task[(string, int32)]? = nil
        var ref same Task[(string, int32)]? = OWNER.Slot(&direct)
        var values []Task[Task[(string, int32)]]? = []Task[Task[(string, int32)]]?{nil}
        var ref alias Task[Task[(string, int32)]]? = OWNER.Slot(&values[Next()])
        let ref readonly view Task[Task[(string, int32)]]? = OWNER.View[Task[(string, int32)]](&alias)
        let payload = Task.FromResult[(string, int32)](("changed", 42))
        let next = Task.FromResult[Task[(string, int32)]](payload)
        OWNER.Set[Task[(string, int32)]](out alias, next)
        same = payload
        var fixed Task[([3]int32, int32)]? = nil
        var ref fixedAlias Task[([3]int32, int32)]? = OWNER.Slot(&fixed)
        fixedAlias = Task.FromResult[([3]int32, int32)](([3]int32{1, 2, 3}, 4))
        Console.WriteLine(view!!.Result.Result.Item1)
        Console.WriteLine(values[0]!!.Result.Result.Item2)
        Console.WriteLine(fixed!!.Result.Item1.Length)
        Console.WriteLine(Calls)
        Console.WriteLine(object.ReferenceEquals(next, OWNER.Identity(alias)))
        var number Task[int32]? = nil
        var ref control Task[int32]? = OWNER.Slot(&number)
        control = Task.FromResult[int32](7)
        Console.WriteLine(number!!.Result)
        let named = OWNER.Identity(Task.FromResult[(Text string, Code int32)](("named", 9)))
        Console.WriteLine(named?.Result.Text)
        Console.WriteLine(direct!!.Result.Item2)
        alias = nil
        Console.WriteLine(view == nil)
    }
}`.Replace("OWNER", owner), "Source6039", executable: true, "/r:" + contract)
        Assert.Equal(
            Encoding.UTF8.GetBytes("changed\n42\n3\n1\nTrue\n7\nnamed\n42\nTrue\n".Replace("\n", Environment.NewLine)),
            fixture.RunBytes(dll)
        )
        let consumer = fixture.CompileCSharp(`using System.Threading.Tasks;
using Source6039;
public static class Consumer {
    public static bool Run() {
        Task<(string, int)>? value = null;
        ref var alias = ref P.Slot(ref value);
        ref readonly var view = ref P.View(ref value);
        alias = Task.FromResult(("native", 11));
        return view!.Result == ("native", 11) && ReferenceEquals(alias, value);
    }
}`, "Consumer6039", dll, contract)
        IlVerifier.Verify(consumer, []string{dll, contract})
        let assemblies = EmittedFixture.LoadTogether(contract, dll, consumer)
        let native = assemblies[0].GetType("Contracts6039.Contract")!!.GetMethod("Slot")!!
        let emitted = assemblies[1].GetType("Source6039.P")!!.GetMethod("Slot")!!
        Assert.Equal([]uint8{2, 42}, native.GetMethodBody()!!.GetILAsByteArray())
        Assert.Equal(native.GetMethodBody()!!.GetILAsByteArray(), emitted.GetMethodBody()!!.GetILAsByteArray())
        Assert.True(emitted.ReturnType.IsByRef)
        Assert.Equal(
            native.ReturnType.GetElementType()!!.GetGenericTypeDefinition().FullName,
            emitted.ReturnType.GetElementType()!!.GetGenericTypeDefinition().FullName
        )
        Assert.Equal(NullabilityState.Nullable, NullabilityInfoContext().Create(emitted.ReturnParameter).ReadState)
        Assert.Equal(true, assemblies[2].GetType("Consumer")!!.GetMethod("Run")!!.Invoke(nil, nil))
        let (code, diagnostics) = fixture.TryCompile(`package Reject6039
import System.Threading.Tasks
import Contracts6039
shared class P {
    func Identity[T](value Task[T]?) Task[T]? { return value }
    func Main() {
        var missing Task[(string, int32)]? = nil
        let required Task[(string, int32)] = OWNER.Identity(missing)
    }
}`.Replace("OWNER", owner), "Reject6039", executable: true, "/r:" + contract)
        Assert.NotEqual(0, code)
        let end = if imported {
            72
        } else {
            65
        }
        Assert.True(
            diagnostics.Contains("Reject6039.gs(8,46,8,$end): error GS0155", StringComparison.Ordinal),
            diagnostics
        )
    }
}
