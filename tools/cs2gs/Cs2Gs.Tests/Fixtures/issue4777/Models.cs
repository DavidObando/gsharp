#nullable enable
namespace EqMatrix;

public record Root(int Tag);
public record Middle(int Tag, int MiddleValue) : Root(Tag);
public sealed record Leaf(int Tag, int MiddleValue, int Extra) : Middle(Tag, MiddleValue);
public sealed record Sibling(int Tag, int Other) : Root(Tag);
public sealed record Reference(string? Value);
public readonly record struct ValueRecord(int Value);
public record struct NullableValueRecord(int? Value);
public record EmptyRoot;
public sealed record EmptyLeaf : EmptyRoot;
public sealed record EmptySibling : EmptyRoot;
public record GenericRoot<T>(T? Value) where T : class;
public sealed record GenericLeaf<T>(T? Value, int Extra) : GenericRoot<T>(Value) where T : class;
public record PairRoot<A, B>(A First, B Second);
public sealed record Swapped<B, A>(A First, B Second, int Extra) : PairRoot<A, B>(First, Second);
public class Owner<T>
{
    public record NestedRoot(T Value);
    public sealed record NestedLeaf(T Value, int Extra) : NestedRoot(Value);
    public record NestedGenericRoot<U>(T First, U Second);
    public sealed record NestedGenericLeaf<U>(T First, U Second, int Extra) : NestedGenericRoot<U>(First, Second);
    public class Inner<U>
    {
        public record DeepRoot(T First, U Second);
        public sealed record DeepLeaf(T First, U Second, int Extra) : DeepRoot(First, Second);
    }
}
