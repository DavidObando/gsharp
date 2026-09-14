// inventory: MakeRefExpression — UnsupportedByDesign/NoGsharpConstruct
// Legacy TypedReference machinery; G# has no analog and none is planned.
namespace Cs2Gs.Fixtures.Unsupported;

public static class MakeRefFixture
{
    public static int ReadViaTypedReference()
    {
        int value = 42;
        System.TypedReference reference = __makeref(value);
        return __refvalue(reference, int);
    }
}
