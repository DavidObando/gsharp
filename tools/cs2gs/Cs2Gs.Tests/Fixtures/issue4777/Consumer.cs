#nullable enable
using System;
using EqMatrix;

public static class MatrixConsumer
{
    public static bool Run()
    {
        var first = new Leaf(1, 2, 3);
        var different = new Leaf(1, 2, 4);
        var same = new Leaf(1, 2, 3);
        Check(first.Tag == 1 && first.MiddleValue == 2 && first.Extra == 3 && different.Extra == 4, "values");
        Check(!((Root)first).Equals((Root)different), "baseDifferent");
        Check(!((Root)first).Equals(new Leaf(2, 2, 3))
            && !((Root)first).Equals(new Leaf(1, 4, 3)), "inheritedFieldsDifferent");
        Check(!((Middle)first).Equals((Middle)different), "middleDifferent");
        Check(!first.Equals(different), "selfDifferent");
        Check(!((IEquatable<Root>)first).Equals(different), "interfaceRootDifferent");
        Check(!((IEquatable<Middle>)first).Equals(different), "interfaceMiddleDifferent");
        Check(!((IEquatable<Leaf>)first).Equals(different), "interfaceSelfDifferent");
        Check(!((object)first).Equals(different), "objectDifferent");
        Check(first != different && !((Root)first == (Root)different), "operatorsDifferent");
        Check(((Root)first).Equals((Root)same), "baseSame");
        Check(((Middle)first).Equals((Middle)same), "middleSame");
        Check(first.Equals(same) && ((IEquatable<Leaf>)first).Equals(same), "selfSame");
        Check(first.GetHashCode() == same.GetHashCode(), "equalHashes");
        Check(first == same && (Root)first == (Root)same, "operatorsSame");
        Check(((Root)first).Equals((Root)first), "identity");
        Check(!((Root)first).Equals(null) && !first.Equals((Leaf?)null) && !((object)first).Equals(null), "null");
        Check(!((Root)first).Equals(new Sibling(1, 3)), "siblings");
        Check(!new Root(1).Equals(first) && !((Root)first).Equals(new Root(1)), "baseVsDerived");
        Check(new Reference(null).Equals(new Reference(null)) && !new Reference(null).Equals(new Reference("x")), "referenceNullable");
        Check(((IEquatable<ValueRecord>)new ValueRecord(1)).Equals(new ValueRecord(1))
            && !((IEquatable<ValueRecord>)new ValueRecord(1)).Equals(new ValueRecord(2)), "valueRecord");
        Check(((IEquatable<NullableValueRecord>)new NullableValueRecord(null)).Equals(new NullableValueRecord(null))
            && !new NullableValueRecord(null).Equals(new NullableValueRecord(1)), "nullableValueRecord");
        var empty = new EmptyLeaf();
        Check(((EmptyRoot)empty).Equals(new EmptyLeaf())
            && !((IEquatable<EmptyRoot>)empty).Equals(new EmptySibling())
            && !((EmptyRoot)empty).Equals(new EmptyRoot()), "zeroFieldHierarchy");
        var generic = new GenericLeaf<string>(null, 1);
        Check(!((GenericRoot<string>)generic).Equals(new GenericLeaf<string>(null, 2))
            && ((IEquatable<GenericRoot<string>>)generic).Equals(new GenericLeaf<string>(null, 1)), "generic");
        Check(!((GenericRoot<string>)new GenericLeaf<string>("left", 1)).Equals(new GenericLeaf<string>("right", 1))
            && !((GenericRoot<string>)generic).Equals(new GenericLeaf<string>("value", 1)), "genericReferenceFieldsDifferent");
        var swapped = new Swapped<string, int>(4, "text", 1);
        Check(!((PairRoot<int, string>)swapped).Equals(new Swapped<string, int>(4, "text", 2))
            && ((PairRoot<int, string>)swapped).Equals(new Swapped<string, int>(4, "text", 1)), "genericOwnerPermutation");
        var nested = new Owner<string>.NestedLeaf("text", 1);
        Check(!((Owner<string>.NestedRoot)nested).Equals(new Owner<string>.NestedLeaf("text", 2))
            && ((IEquatable<Owner<string>.NestedRoot>)nested).Equals(new Owner<string>.NestedLeaf("text", 1)), "nestedOwner");
        var nestedGeneric = new Owner<string>.NestedGenericLeaf<int>("text", 4, 1);
        Check(!((Owner<string>.NestedGenericRoot<int>)nestedGeneric).Equals(new Owner<string>.NestedGenericLeaf<int>("text", 4, 2))
            && ((IEquatable<Owner<string>.NestedGenericRoot<int>>)nestedGeneric).Equals(new Owner<string>.NestedGenericLeaf<int>("text", 4, 1)), "nestedOwnGeneric");
        var deep = new Owner<string>.Inner<int>.DeepLeaf("text", 4, 1);
        Check(!((Owner<string>.Inner<int>.DeepRoot)deep).Equals(new Owner<string>.Inner<int>.DeepLeaf("text", 4, 2))
            && ((IEquatable<Owner<string>.Inner<int>.DeepRoot>)deep).Equals(new Owner<string>.Inner<int>.DeepLeaf("text", 4, 1)), "deepNestedOwner");
        return true;
    }

    private static void Check(bool result, string name)
    {
        if (!result)
        {
            throw new InvalidOperationException("Native structural equality assertion failed: " + name);
        }
    }
}
