// inventory: BaseConstructorInitializer — derived constructor chaining : base(...)
using System;

namespace Corpus.Grid07
{
    public class VehicleBase
    {
        private readonly string _kind;

        public VehicleBase(string kind)
        {
            _kind = kind;
        }

        public string Kind()
        {
            return _kind;
        }
    }

    public class Truck : VehicleBase
    {
        private readonly int _wheels;

        public Truck(int wheels)
            : base("truck")
        {
            _wheels = wheels;
        }

        public int Wheels()
        {
            return _wheels;
        }
    }

    public static class BaseConstructorInitializerFixture
    {
        public static void Run()
        {
            Truck truck = new Truck(6);
            Console.WriteLine("BaseConstructorInitializer: kind=" + truck.Kind() + " wheels=" + truck.Wheels().ToString());
        }
    }
}
