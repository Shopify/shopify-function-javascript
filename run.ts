export type UserFunction<Input extends {}, Output extends {}> = (
  input: Input
) => Output;

interface Javy {
  JSON: {
    fromStdin(): any;
    toStdout(val: any);
  }
}

interface ShopifyFunction {
  readInput(): any;
  writeOutput(val: any);
}

declare global {
  const Javy: Javy;
  const ShopifyFunction: ShopifyFunction;
}

export default function <I extends {}, O extends {}>(
  userfunction: UserFunction<I, O>
) {
  if (Javy.JSON) {
    const input_obj = Javy.JSON.fromStdin();
    const output_obj = userfunction(input_obj);
    Javy.JSON.toStdout(output_obj);
  } else if (ShopifyFunction) {
    const input_obj = ShopifyFunction.readInput();
    const output_obj = userfunction(input_obj);
    ShopifyFunction.writeOutput(output_obj);
  } else {
    throw new Error(
      "ShopifyFunction is not defined. Please rebuild your function using the latest version of Shopify CLI."
    );
  }
}
