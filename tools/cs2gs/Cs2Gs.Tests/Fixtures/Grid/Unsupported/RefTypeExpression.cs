// inventory: RefTypeExpression — UnsupportedByDesign/NoGsharpConstruct
// Legacy TypedReference machinery; G# has no analog and none is planned.
namespace Cs2Gs.Fixtures.Unsupported;

public static class RefTypeFixture
{
    public static System.Type TypeOfTypedReference()
    {
        int value = 7;
        System.TypedReference reference = __makeref(value);
        return __reftype(reference);
    }
}
